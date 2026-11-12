import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { BolideError, createApp, createLogger, defineService, defineValue, defineModule, ValidationError } from '@bolide/core'
import { memoryQueue, Queue, queueModule } from '@bolide/queue'
import { consoleTransport, httpTransport, Mailer, mailModule, MailTransport, memoryTransport, prepareMail, smtpTransport } from '../src/index.ts'
import { SendMail } from '../src/queue.ts'

const quiet = createLogger({ write: () => {} })

describe('prepareMail', () => {
  test('normalizes recipients and fills from', () => {
    const m = prepareMail({ to: 'Ann <ann@x.io>', bcc: ['b@x.io'], subject: 'Hi', text: 'hello' }, 'Shop <shop@x.io>')
    assert.deepEqual([m.to, m.cc, m.bcc, m.from], [['Ann <ann@x.io>'], [], ['b@x.io'], 'Shop <shop@x.io>'])
  })

  test('rejects what would break or abuse the message', () => {
    const ok = { to: 'a@x.io', subject: 's', text: 't', from: 'f@x.io' }
    const cases: [object, RegExp][] = [
      [{ ...ok, from: undefined }, /no from address/],
      [{ ...ok, to: [] }, /no recipients/],
      [{ ...ok, to: 'nobody' }, /to "nobody" is not an email address/],
      [{ ...ok, to: 'a@x.io\r\nBcc: victim@x.io' }, /is not an email address/],
      [{ ...ok, to: 'a@x.io, victim@y.io <a@x.io>' }, /is not an email address/],
      [{ ...ok, to: 'victim@y.io;<a@x.io>' }, /is not an email address/],
      [{ ...ok, cc: '"x" victim@y.io, "y" <a@x.io>' }, /is not an email address/],
      [{ ...ok, to: '"a\\" , b@y.io" <a@x.io>' }, /is not an email address/],
      [{ ...ok, to: 'a,b@x.io' }, /is not an email address/],
      [{ ...ok, subject: 'Hi\r\nBcc: victim@x.io' }, /one line/],
      [{ ...ok, text: undefined }, /add text or html/],
      [{ ...ok, headers: { 'X-Ok': 'a\nb' } }, /not a valid one-line header/],
      [{ ...ok, attachments: [{ filename: 'a"b', content: '' }] }, /filename/],
    ]
    for (const to of ['Ann <a@x.io>', '"Doe, Ann" <a@x.io>', '"ann@x.io" <a@x.io>', ' a@x.io ']) assert.equal(prepareMail({ ...ok, to }).to[0], to)
    for (const [message, error] of cases) assert.throws(() => prepareMail(message as never), (e: Error) => e instanceof BolideError && error.test(e.message), String(error))
  })
})

describe('mailModule', () => {
  test('Mailer checks and sends through the transport; tests read the memory transport', async () => {
    const transport = memoryTransport()
    const Signup = defineService({ name: 'Signup', inject: { mailer: Mailer }, factory: ({ mailer }) => ({ welcome: (to: string) => mailer.send({ to, subject: 'Welcome', text: 'Hi!' }) }) })
    const app = await createApp({ modules: [mailModule({ transport, from: 'Shop <shop@x.io>' }), defineModule({ name: 'users', providers: [Signup] })], logger: quiet })
    assert.deepEqual(await app.get(Signup).welcome('Ann <ann@x.io>'), { id: 'memory-1' })
    assert.equal(transport.lastTo('ann@x.io')?.subject, 'Welcome')
    assert.equal(transport.lastTo('ann@x.io')?.from, 'Shop <shop@x.io>')
    assert.equal(transport.lastTo('bob@x.io'), undefined)
    await assert.rejects(app.get(Signup).welcome('not-an-address'), /not an email address/)
    assert.equal(transport.sent.length, 1)
  })

  test('a transport can be a service built from config', async () => {
    const sent: string[] = []
    const Url = defineValue('MailUrl', 'smtp://x')
    const config = defineModule({ name: 'config', providers: [Url], exports: [Url] })
    const Smtp = defineService({ name: 'Smtp', inject: { url: Url }, factory: ({ url }) => ({ send: async (m: { subject: string }) => void sent.push(`${url} ${m.subject}`) }) })
    const app = await createApp({ modules: [mailModule({ transport: Smtp, from: 'a@x.io', imports: [config] })], logger: quiet })
    await app.get(Mailer).send({ to: 'b@x.io', subject: 'S', html: '<p>x</p>' })
    assert.deepEqual(sent, ['smtp://x S'])
    assert.equal(typeof app.get(MailTransport).send, 'function')
  })

  test('bad module options fail when defined', () => {
    assert.throws(() => mailModule({ transport: memoryTransport(), from: 'nope' }), /from "nope"/)
    assert.throws(() => mailModule({ transport: undefined as never }), /needs a transport/)
  })
})

describe('transports', () => {
  test('smtpTransport maps onto nodemailer sendMail', async () => {
    let options: Record<string, unknown> | undefined
    const t = smtpTransport({ sendMail: async (o) => ((options = o), { messageId: '<1@x>' }) })
    const result = await t.send(prepareMail({ to: 'a@x.io', subject: 's', text: 't', attachments: [{ filename: 'a.bin', content: new Uint8Array([1, 2]) }] }, 'f@x.io'))
    assert.deepEqual(result, { id: '<1@x>' })
    assert.deepEqual([options!.from, options!.to, options!.subject], ['f@x.io', ['a@x.io'], 's'])
    assert.ok(Buffer.isBuffer((options!.attachments as { content: unknown }[])[0]!.content))
  })

  test('consoleTransport logs instead of sending', async () => {
    const lines: string[] = []
    await consoleTransport({ info: (msg) => void lines.push(msg) }).send(prepareMail({ to: 'a@x.io', subject: 'Hello', text: 't' }, 'f@x.io'))
    assert.deepEqual(lines, ['mail to a@x.io: Hello'])
  })

  test('httpTransport posts JSON and turns errors into exceptions', async () => {
    const bodies: unknown[] = []
    const server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        bodies.push({ auth: req.headers.authorization, body: JSON.parse(data) })
        res.writeHead(req.url === '/fail' ? 422 : 200, { 'content-type': 'application/json' })
        res.end(req.url === '/fail' ? '{"message":"bad sender"}' : '{"id":"msg-1"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as { port: number }).port
    try {
      const make = (path: string) =>
        httpTransport({ url: `http://localhost:${port}${path}`, headers: { authorization: 'Bearer k' }, body: (m) => ({ to: m.to, subject: m.subject }), id: (r) => (r as { id: string }).id })
      const mail = prepareMail({ to: 'a@x.io', subject: 's', text: 't' }, 'f@x.io')
      assert.deepEqual(await make('/send').send(mail), { id: 'msg-1' })
      assert.deepEqual(bodies[0], { auth: 'Bearer k', body: { to: ['a@x.io'], subject: 's' } })
      await assert.rejects(make('/fail').send(mail), /answered 422: \{"message":"bad sender"\}/)
    } finally {
      server.close()
    }
  })
})

describe('SendMail job', () => {
  test('queues mail, checks it at enqueue time, and sends it from the worker', async () => {
    const transport = memoryTransport()
    const driver = memoryQueue()
    const app = await createApp({ modules: [mailModule({ transport, from: 'f@x.io' }), queueModule({ jobs: [SendMail], driver })], logger: quiet })
    const queue = app.get(Queue)
    await queue.enqueue(SendMail, { to: 'a@x.io', subject: 'Later', text: 't' })
    await assert.rejects(queue.enqueue(SendMail, { to: 'nope', subject: 'x', text: 't' }), ValidationError)
    await queue.idle()
    assert.equal(transport.lastTo('a@x.io')?.subject, 'Later')
    assert.equal(driver.messages()[0]!.status, 'done')
    await app.close()
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createApp, createLogger, defineModule, defineService, override, ValidationError, type LogRecord, type Tracer } from '@bolide/core'
import { defineJob, defineSchedule, memoryQueue, Queue, QueueDriver, queueModule } from '../src/index.ts'

const quiet = createLogger({ write: () => {} })

function collect() {
  const records: LogRecord[] = []
  return { records, logger: createLogger({ level: 'debug', write: (r) => void records.push(r) }) }
}

const Mailbox = defineService({ name: 'Mailbox', factory: () => [] as string[] })
const mail = defineModule({ name: 'mail', providers: [Mailbox], exports: [Mailbox] })

const Welcome = defineJob({
  name: 'welcome',
  schema: z.object({ email: z.email(), name: z.string().default('friend') }),
  inject: { box: Mailbox },
  handler: ({ email, name }, { box }) => void box.push(`${email}: hi ${name}`),
})

describe('jobs', () => {
  test('enqueue validates the payload and a worker runs the job with its deps', async () => {
    const driver = memoryQueue()
    const app = await createApp({ modules: [mail, queueModule({ jobs: [Welcome], driver, imports: [mail] })], logger: quiet })
    const queue = app.get(Queue)
    await queue.enqueue(Welcome, { email: 'ann@x.io' })
    await assert.rejects(queue.enqueue(Welcome, { email: 'nope' }), ValidationError)
    await queue.idle()
    assert.deepEqual(app.get(Mailbox), ['ann@x.io: hi friend'])
    assert.deepEqual(
      driver.messages().map((m) => [m.job, m.status, m.attempts, m.payload]),
      [['welcome', 'done', 1, { email: 'ann@x.io' }]],
    )
    await app.close()
  })

  test('failures retry with backoff, then the message is dead', async () => {
    let runs = 0
    const Flaky = defineJob({
      name: 'flaky',
      retries: 2,
      backoff: 0,
      handler: (_p, _d, { attempt }) => {
        runs++
        if (attempt < 3) throw new Error(`fail ${attempt}`)
      },
    })
    const Broken = defineJob({ name: 'broken', retries: 1, backoff: (n) => n - 1, handler: () => Promise.reject(new Error('always')) })
    const driver = memoryQueue()
    const { records, logger } = collect()
    const app = await createApp({ modules: [queueModule({ jobs: [Flaky, Broken], driver })], logger })
    const queue = app.get(Queue)
    await queue.enqueue(Flaky)
    await queue.enqueue(Broken)
    await queue.idle()
    assert.equal(runs, 3)
    const [flaky, broken] = driver.messages()
    assert.equal(flaky!.status, 'done')
    assert.deepEqual([broken!.status, broken!.attempts, broken!.error], ['dead', 2, 'always'])
    assert.equal(records.filter((r) => r.msg === 'job failed, will retry').length, 3)
    const gaveUp = records.find((r) => r.msg === 'job failed, giving up')!
    assert.deepEqual([gaveUp.fields.job, gaveUp.fields.attempt], ['broken', 2])
    await app.close()
  })

  test('a job past its timeout is aborted and counted as failed', async () => {
    let signal: AbortSignal | undefined
    const Slow = defineJob({ name: 'slow', retries: 0, timeout: 20, handler: (_p, _d, ctx) => {
      signal = ctx.signal
      return new Promise(() => {})
    } })
    const driver = memoryQueue()
    const app = await createApp({ modules: [queueModule({ jobs: [Slow], driver })], logger: quiet })
    await app.get(Queue).enqueue(Slow)
    await app.get(Queue).idle()
    assert.equal(signal!.aborted, true)
    assert.match(driver.messages()[0]!.error!, /timed out after 20ms/)
    await app.close()
  })

  test('delayed messages wait, idempotency keys dedupe', async () => {
    const seen: number[] = []
    const Tick = defineJob({ name: 'tick', schema: z.number(), handler: (n) => void seen.push(n) })
    const app = await createApp({ modules: [queueModule({ jobs: [Tick], pollInterval: 10 })], logger: quiet })
    const queue = app.get(Queue)
    assert.ok(await queue.enqueue(Tick, 1, { key: 'once' }))
    assert.equal(await queue.enqueue(Tick, 2, { key: 'once' }), undefined)
    await queue.enqueue(Tick, 3, { delay: 30 })
    await queue.idle()
    assert.deepEqual(seen, [1])
    await new Promise((r) => setTimeout(r, 60))
    await queue.idle()
    assert.deepEqual(seen, [1, 3])
    await app.close()
  })

  test('concurrency caps parallel runs', async () => {
    let now = 0
    let peak = 0
    const Work = defineJob({ name: 'work', handler: async () => {
      peak = Math.max(peak, ++now)
      await new Promise((r) => setTimeout(r, 5))
      now--
    } })
    const app = await createApp({ modules: [queueModule({ jobs: [Work], concurrency: 2 })], logger: quiet })
    for (let i = 0; i < 6; i++) await app.get(Queue).enqueue(Work)
    await app.get(Queue).idle()
    assert.equal(peak, 2)
    await app.close()
  })

  test('close() waits for running jobs', async () => {
    let finished = false
    const Work = defineJob({ name: 'work', handler: async () => {
      await new Promise((r) => setTimeout(r, 20))
      finished = true
    } })
    const app = await createApp({ modules: [queueModule({ jobs: [Work] })], logger: quiet })
    await app.get(Queue).enqueue(Work)
    await new Promise((r) => setTimeout(r, 1))
    await app.close()
    assert.equal(finished, true)
  })

  test('close() aborts jobs that outlive shutdownTimeout', async () => {
    let aborted = false
    const Stuck = defineJob({ name: 'stuck', handler: (_p, _d, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true
      reject(signal.reason)
    })) })
    const app = await createApp({ modules: [queueModule({ jobs: [Stuck], shutdownTimeout: 10 })], logger: quiet })
    await app.get(Queue).enqueue(Stuck)
    await new Promise((r) => setTimeout(r, 1))
    await app.close()
    assert.equal(aborted, true)
  })

  test('a message stored with an invalid payload is dead without retries', async () => {
    const driver = memoryQueue()
    const app = await createApp({ modules: [mail, queueModule({ jobs: [Welcome], driver, imports: [mail] })], logger: quiet })
    await driver.push({ job: 'welcome', payload: '{"email":1}', runAt: new Date(), maxAttempts: 4 })
    await app.get(Queue).idle()
    assert.deepEqual([driver.messages()[0]!.status, driver.messages()[0]!.attempts], ['dead', 1])
    await app.close()
  })

  test('a leased message whose worker died past its last attempt is not run again', async () => {
    let runs = 0
    const Once = defineJob({ name: 'once', retries: 0, handler: () => void runs++ })
    let t = 0
    const driver = memoryQueue({ now: () => t })
    await driver.push({ job: 'once', payload: 'null', runAt: new Date(0), maxAttempts: 1 })
    await driver.reserve(['once'], 10) // a worker took it and died
    t = 100
    const app = await createApp({ modules: [queueModule({ jobs: [Once], driver })], logger: quiet })
    await app.get(Queue).idle()
    assert.equal(runs, 0)
    assert.equal(driver.messages()[0]!.status, 'dead')
    await app.close()
  })

  test('producer-only processes enqueue without running jobs', async () => {
    const driver = memoryQueue()
    const app = await createApp({ modules: [mail, queueModule({ jobs: [Welcome], driver, imports: [mail], worker: false })], logger: quiet })
    await app.get(Queue).enqueue(Welcome, { email: 'a@b.co' })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(driver.messages()[0]!.status, 'pending')
    await assert.rejects(app.get(Queue).idle(), /needs a worker/)
    await app.close()
  })

  test('each run is a consumer span; failures are recorded on it', async () => {
    const spans: { name: string; kind?: string; attributes?: object; errors: unknown[] }[] = []
    const tracer: Tracer = {
      span: async (name, fn, o) => {
        const s = { name, kind: o?.kind, attributes: o?.attributes, errors: [] as unknown[] }
        spans.push(s)
        return fn({ setAttribute() {}, updateName() {}, recordError: (e) => void s.errors.push(e) })
      },
    }
    const Fails = defineJob({ name: 'fails', retries: 0, handler: () => Promise.reject(new Error('x')) })
    const app = await createApp({ modules: [queueModule({ jobs: [Fails] })], logger: quiet, tracer })
    await app.get(Queue).enqueue(Fails)
    await app.get(Queue).idle()
    const job = spans.find((s) => s.name === 'job fails')!
    assert.equal(job.kind, 'consumer')
    assert.deepEqual(job.attributes, { 'job.name': 'fails', 'job.id': '1', 'job.attempt': 1 })
    assert.equal((job.errors[0] as Error).message, 'x')
    await app.close()
  })

  test('tests can swap the driver with override()', async () => {
    const fake = memoryQueue()
    const app = await createApp({ modules: [mail, queueModule({ jobs: [Welcome], imports: [mail], worker: false })], logger: quiet, overrides: [override(QueueDriver, { useValue: fake })] })
    await app.get(Queue).enqueue(Welcome, { email: 'a@b.co' })
    assert.equal(fake.messages('welcome').length, 1)
    await app.close()
  })
})

describe('boot-time checks', () => {
  test("a job's deps must be visible to the queue module", async () => {
    await assert.rejects(
      createApp({ modules: [mail, queueModule({ jobs: [Welcome] })], logger: quiet }),
      /job "welcome".*injects "Mailbox", which is not visible/,
    )
  })

  test('unregistered jobs, payloads on schema-less jobs, duplicates and bad options', async () => {
    const Other = defineJob({ name: 'other', handler: () => {} })
    const app = await createApp({ modules: [queueModule({ jobs: [Other], worker: false })], logger: quiet })
    await assert.rejects(app.get(Queue).enqueue(Welcome, { email: 'a@b.co' }), /not registered. Add it to queueModule/)
    // @ts-expect-error a job without a schema takes no payload
    await assert.rejects(app.get(Queue).enqueue(Other, 1), /takes no payload/)
    await app.close()
    assert.throws(() => queueModule({ jobs: [Other, defineJob({ name: 'other', handler: () => {} })] }), /two jobs are named "other"/)
    assert.throws(() => queueModule({ jobs: [], concurrency: 0 }), /concurrency must be a positive integer/)
    assert.throws(() => defineJob({ name: 'x', retries: -1, handler: () => {} }), /retries must be/)
    assert.throws(() => defineJob({ name: 'x', timeout: 'soon' as never, handler: () => {} }), /timeout must be/)
  })
})

describe('schedules', () => {
  test('schedules must use registered jobs and valid payloads', async () => {
    const Report = defineJob({ name: 'report', schema: z.object({ to: z.email() }), handler: () => {} })
    assert.throws(() => queueModule({ jobs: [], schedules: [defineSchedule({ cron: '@daily', job: Report, payload: { to: 'a@b.co' } })] }), /not in queueModule/)
    assert.throws(() => defineSchedule({ cron: '61 * * * *', job: Report, payload: { to: 'a@b.co' } }), /minute "61"/)
    const bad = queueModule({ jobs: [Report], schedules: [defineSchedule({ cron: '@daily', job: Report, payload: { to: 'nope' } })] })
    await assert.rejects(createApp({ modules: [bad], logger: quiet }), /payload of schedule "report"/)
  })

  test('each slot is enqueued once, even with two schedulers on one driver', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-01-01T00:00:30Z') })
    const Ping = defineJob({ name: 'ping', handler: () => {} })
    const driver = memoryQueue()
    const module = () => queueModule({ jobs: [Ping], driver, worker: false, scheduler: true, schedules: [defineSchedule({ cron: '* * * * *', job: Ping })] })
    const a = await createApp({ modules: [module()], logger: quiet })
    const b = await createApp({ modules: [module()], logger: quiet })
    t.mock.timers.tick(30_000)
    await new Promise((r) => setImmediate(r))
    t.mock.timers.tick(60_000)
    await new Promise((r) => setImmediate(r))
    const msgs = driver.messages('ping')
    assert.deepEqual(msgs.map((m) => m.runAt.toISOString()), ['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z'])
    await a.close()
    await b.close()
  })
})

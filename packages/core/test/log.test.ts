import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BolideError,
  createApp,
  createLogger,
  defineModule,
  defineRoute,
  defineService,
  formatPretty,
  HttpError,
  Log,
  override,
  RequestLog,
  serializeError,
  type LogRecord,
} from '../src/index.ts'

const get = (app: { fetch(r: Request): Promise<Response> }, path: string, init?: RequestInit) => app.fetch(new Request(`http://x${path}`, init))

function collect(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const records: LogRecord[] = []
  return { records, logger: createLogger({ level, write: (r) => void records.push(r) }) }
}

describe('logger', () => {
  test('drops records below the level and merges child fields', () => {
    const { records, logger } = collect('info')
    logger.debug('hidden')
    const child = logger.child({ a: 1 }).child({ b: 2 })
    child.info('shown', { b: 3 })
    assert.equal(records.length, 1)
    assert.deepEqual(records[0]!.fields, { a: 1, b: 3 })
    assert.equal(logger.enabled('debug'), false)
    assert.equal(logger.enabled('warn'), true)
  })

  test('rejects an unknown level at creation', () => {
    assert.throws(() => createLogger({ level: 'verbose' as never }), BolideError)
  })

  test('json lines keep errors and their causes, and fixed keys win', (t) => {
    const lines: string[] = []
    t.mock.method(console, 'error', (line: string) => void lines.push(line))
    const err = new Error('outer', { cause: new HttpError(409, 'inner') })
    createLogger({ format: 'json' }).error('failed', { err, msg: 'spoof', level: 'debug' })
    const line = JSON.parse(lines[0]!)
    assert.equal(line.msg, 'failed')
    assert.equal(line.level, 'error')
    assert.equal(line.err.message, 'outer')
    assert.equal(line.err.cause.status, 409)
    assert.equal(line.err.cause.code, 'conflict')
    assert.match(line.time, /^\d{4}-\d\d-\d\dT/)
  })

  test('json lines survive fields that cannot be encoded', (t) => {
    const lines: string[] = []
    t.mock.method(console, 'log', (line: string) => void lines.push(line))
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    createLogger({ format: 'json' }).info('still logged', { cyclic })
    assert.equal(JSON.parse(lines[0]!).msg, 'still logged')
  })

  test('pretty lines show fields and indent stacks', () => {
    const err = new Error('boom')
    const text = formatPretty({ time: new Date('2026-01-01T10:00:00.123Z'), level: 'warn', msg: 'hello', fields: { id: 'x', n: 2, err } })
    const [head, ...rest] = text.split('\n')
    assert.equal(head, '10:00:00.123 WARN  hello id=x n=2 err=Error')
    assert.match(rest[0]!, /^ {4}Error: boom/)
  })

  test('serializeError leaves other values alone', () => {
    assert.equal(serializeError('text'), 'text')
    const agg = serializeError(new AggregateError([new Error('a')], 'many')) as { errors: { message: string }[] }
    assert.equal(agg.errors[0]!.message, 'a')
  })
})

describe('request logging', () => {
  const echo = defineRoute({ method: 'GET', path: '/users/:id', inject: { log: RequestLog }, handler: ({ params }, { log }) => {
    log.info('loading user', { id: params.id })
    return { id: params.id }
  } })
  const fail = defineRoute({ method: 'GET', path: '/fail', handler: () => {
    throw new Error('boom')
  } })
  const m = defineModule({ name: 'm', routes: [echo, fail] })

  test('every request gets an id, a response header and an access log line', async () => {
    const { records, logger } = collect()
    const app = await createApp({ modules: [m], logger })
    const res = await get(app, '/users/7')
    const id = res.headers.get('x-request-id')!
    assert.match(id, /^[0-9a-f-]{36}$/)
    const [own, access] = records
    assert.equal(own!.msg, 'loading user')
    assert.deepEqual(own!.fields, { reqId: id, id: '7' })
    assert.equal(access!.level, 'info')
    assert.match(access!.msg, /^GET \/users\/7 200 [\d.]+ms$/)
    assert.equal(access!.fields.route, '/users/:id')
    assert.equal(access!.fields.status, 200)
    assert.equal(access!.fields.reqId, id)
  })

  test('a safe incoming x-request-id is reused, an unsafe one replaced', async () => {
    const app = await createApp({ modules: [m], logger: collect().logger })
    const ok = await get(app, '/users/1', { headers: { 'x-request-id': 'edge-42.a:b' } })
    assert.equal(ok.headers.get('x-request-id'), 'edge-42.a:b')
    const bad = await get(app, '/users/1', { headers: { 'x-request-id': 'a bé' } })
    assert.notEqual(bad.headers.get('x-request-id'), 'a bé')
  })

  test('errors are logged with the request id; status sets the access level', async () => {
    const { records, logger } = collect()
    const app = await createApp({ modules: [m], logger })
    const res = await get(app, '/fail')
    assert.equal(res.status, 500)
    const id = res.headers.get('x-request-id')
    const [error, access] = records
    assert.equal(error!.msg, 'unhandled error')
    assert.equal(error!.fields.reqId, id)
    assert.equal((error!.fields.err as Error).message, 'boom')
    assert.equal(access!.level, 'error')
    await get(app, '/nope')
    assert.equal(records.at(-1)!.level, 'warn')
    assert.equal(records.at(-1)!.fields.route, undefined)
  })

  test('accessLog: false keeps only what the app logs', async () => {
    const { records, logger } = collect()
    const app = await createApp({ modules: [m], logger, accessLog: false })
    await get(app, '/users/1')
    assert.deepEqual(records.map((r) => r.msg), ['loading user'])
  })

  test('the request id header survives immutable responses', async () => {
    const r = defineRoute({ method: 'GET', path: '/go', handler: () => Response.redirect('http://x/users/1', 302) })
    const app = await createApp({ modules: [defineModule({ name: 'r', routes: [r] })], logger: collect().logger })
    const res = await get(app, '/go')
    assert.equal(res.status, 302)
    assert.ok(res.headers.get('x-request-id'))
  })

  test('services inject Log; an override of Log also gets the access log', async () => {
    const { records, logger } = collect()
    const Users = defineService({ name: 'Users', inject: { log: Log }, factory: ({ log }) => log.child({ svc: 'users' }) })
    const app = await createApp({ modules: [defineModule({ name: 'u', providers: [Users], routes: [echo] })], overrides: [override(Log, { useValue: logger })] })
    app.get(Users).info('ready')
    await get(app, '/users/1')
    assert.deepEqual(records.map((r) => r.msg.split(' ')[0]), ['ready', 'loading', 'GET'])
    assert.equal(records[0]!.fields.svc, 'users')
  })

  test('LOG_LEVEL and LOG_FORMAT are checked at boot', async () => {
    await assert.rejects(createApp({ modules: [m], env: { LOG_LEVEL: 'loud' } }), /LOG_LEVEL must be/)
    await assert.rejects(createApp({ modules: [m], env: { LOG_FORMAT: 'xml' } }), /LOG_FORMAT must be/)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  createApp,
  CurrentRequest,
  defineGuard,
  defineMiddleware,
  defineModule,
  defineRoute,
  defineService,
  DependencyError,
  HttpError,
} from '../src/index.ts'

const get = (app: { fetch(r: Request): Promise<Response> }, path: string, init?: RequestInit) => app.fetch(new Request(`http://x${path}`, init))

function tracer(name: string, log: string[]) {
  return defineMiddleware({
    name,
    handle: async (_ctx, next) => {
      log.push(`${name}>`)
      const res = await next()
      log.push(`<${name}`)
      return res
    },
  })
}

describe('middleware', () => {
  test('app, module and route middleware run outermost first and unwind in reverse', async () => {
    const log: string[] = []
    const route = defineRoute({ method: 'GET', path: '/x', use: [tracer('route', log)], handler: () => (log.push('handler'), 'ok') })
    const m = defineModule({ name: 'm', use: [tracer('module', log)], routes: [route] })
    const app = await createApp({ modules: [m], use: [tracer('app', log)] })
    assert.equal(await (await get(app, '/x')).json(), 'ok')
    assert.deepEqual(log, ['app>', 'module>', 'route>', 'handler', '<route', '<module', '<app'])
  })

  test('app middleware also wraps 404s and the OpenAPI document', async () => {
    const cors = defineMiddleware({
      name: 'cors',
      handle: async (_ctx, next) => {
        const res = await next()
        res.headers.set('access-control-allow-origin', '*')
        return res
      },
    })
    const app = await createApp({ modules: [], use: [cors], openapi: { info: { title: 't', version: '1' } } })
    const missing = await get(app, '/nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('access-control-allow-origin'), '*')
    assert.equal((await get(app, '/openapi.json')).headers.get('access-control-allow-origin'), '*')
  })

  test('middleware can answer without calling next()', async () => {
    const maintenance = defineMiddleware({ name: 'maintenance', handle: () => new Response('down', { status: 503 }) })
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'GET', path: '/x', handler: () => assert.fail('handler ran') })] })
    const app = await createApp({ modules: [m], use: [maintenance] })
    assert.equal((await get(app, '/x')).status, 503)
  })

  test('route middleware knows the matched route; app middleware does not', async () => {
    const seen: unknown[] = []
    const spy = defineMiddleware({ name: 'spy', handle: (ctx, next) => (seen.push(ctx.route), next()) })
    const m = defineModule({ name: 'users', prefix: '/users', use: [spy], routes: [defineRoute({ method: 'GET', path: '/:id', handler: () => 1 })] })
    const app = await createApp({ modules: [m], use: [spy] })
    await get(app, '/users/7')
    assert.deepEqual(seen, [undefined, { method: 'GET', path: '/users/:id', module: 'users' }])
  })

  test('handler errors reach middleware as responses', async () => {
    const statuses: number[] = []
    const logger = defineMiddleware({ name: 'logger', handle: async (_ctx, next) => {
      const res = await next()
      statuses.push(res.status)
      return res
    } })
    const m = defineModule({
      name: 'm',
      use: [logger],
      routes: [
        defineRoute({ method: 'GET', path: '/boom', handler: () => { throw new Error('boom') } }),
        defineRoute({ method: 'GET', path: '/gone', handler: () => { throw new HttpError(410, 'gone') } }),
      ],
    })
    const app = await createApp({ modules: [m], onError: () => {} })
    await get(app, '/boom')
    await get(app, '/gone')
    assert.deepEqual(statuses, [500, 410])
  })

  test('errors from an inner guard reach outer middleware as responses', async () => {
    const statuses: number[] = []
    const logger = defineMiddleware({ name: 'logger', handle: async (_ctx, next) => {
      const res = await next()
      statuses.push(res.status)
      return res
    } })
    const deny = defineGuard({ name: 'deny', check: () => false })
    const m = defineModule({ name: 'm', use: [logger], routes: [defineRoute({ method: 'GET', path: '/x', use: [deny], handler: () => 1 })] })
    const app = await createApp({ modules: [m] })
    assert.equal((await get(app, '/x')).status, 403)
    assert.deepEqual(statuses, [403])
  })

  test('middleware shares request-scoped instances with the handler', async () => {
    let made = 0
    const RequestId = defineService({ name: 'RequestId', scope: 'request', inject: { req: CurrentRequest }, factory: ({ req }) => ({ id: req.headers.get('x-id') ?? `gen-${++made}` }) })
    const tag = defineMiddleware({ name: 'tag', inject: { rid: RequestId }, handle: async (_ctx, next, { rid }) => {
      const res = await next()
      res.headers.set('x-request-id', rid.id)
      return res
    } })
    const route = defineRoute({ method: 'GET', path: '/x', inject: { rid: RequestId }, handler: (_c, { rid }) => rid.id })
    const m = defineModule({ name: 'm', providers: [RequestId], use: [tag], routes: [route] })
    const app = await createApp({ modules: [m] })
    const res = await get(app, '/x')
    assert.equal(res.headers.get('x-request-id'), await res.json())
    assert.equal(made, 1)
  })

  test('misbehaving middleware gives a 500 and is reported', async () => {
    const reported: Error[] = []
    const twice = defineMiddleware({ name: 'twice', handle: async (_c, next) => (await next(), next()) })
    const nothing = defineMiddleware({ name: 'nothing', handle: (() => undefined) as never })
    const route = (path: string, use: any) => defineRoute({ method: 'GET', path, use: [use], handler: () => 1 })
    const app = await createApp({ modules: [defineModule({ name: 'm', routes: [route('/a', twice), route('/b', nothing)] })], onError: (e) => void reported.push(e as Error) })
    assert.equal((await get(app, '/a')).status, 500)
    assert.equal((await get(app, '/b')).status, 500)
    assert.match(reported[0]!.message, /"twice" called next\(\) twice/)
    assert.match(reported[1]!.message, /"nothing" must return a Response/)
  })
})

describe('guards', () => {
  const Session = defineService({
    name: 'Session',
    scope: 'request',
    inject: { req: CurrentRequest },
    factory: ({ req }) => ({ user: req.headers.get('authorization')?.replace('Bearer ', '') }),
  })
  const signedIn = defineGuard({
    name: 'signedIn',
    inject: { session: Session },
    check: (_ctx, { session }) => {
      if (!session.user) throw new HttpError(401, 'sign in first')
      return true
    },
  })
  const admin = defineGuard({ name: 'admin', inject: { session: Session }, check: (_ctx, { session }) => session.user === 'root' })
  const create = defineRoute({ method: 'POST', path: '/things', use: [admin], body: z.object({ n: z.number() }), handler: ({ body }) => body })
  const m = defineModule({ name: 'm', providers: [Session], use: [signedIn], routes: [create] })
  const post = (auth: string | undefined, body: string) =>
    new Request('http://x/things', { method: 'POST', body, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) } })

  test('false gives 403, a thrown HttpError keeps its status, true continues', async () => {
    const app = await createApp({ modules: [m] })
    assert.equal((await app.fetch(post(undefined, '{"n":1}'))).status, 401)
    const denied = await app.fetch(post('Bearer ann', '{"n":1}'))
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { error: 'forbidden', message: 'access denied by guard "admin"' })
    assert.deepEqual(await (await app.fetch(post('Bearer root', '{"n":1}'))).json(), { n: 1 })
  })

  test('guards run before the body is parsed', async () => {
    const app = await createApp({ modules: [m] })
    assert.equal((await app.fetch(post('Bearer ann', '{broken'))).status, 403)
  })
})

describe('boot-time checks', () => {
  const Secret = defineService({ name: 'Secret', factory: () => 's' })
  const usesSecret = defineMiddleware({ name: 'usesSecret', inject: { s: Secret }, handle: (_c, next) => next() })

  test('module middleware must see its dependencies', async () => {
    const other = defineModule({ name: 'other', providers: [Secret] })
    const m = defineModule({ name: 'm', use: [usesSecret] })
    await assert.rejects(createApp({ modules: [m, other] }), (e) => e instanceof DependencyError && /middleware "usesSecret" in module "m" injects "Secret"/.test(e.message))
  })

  test('app middleware sees only exports of the app modules, globals and built-ins', async () => {
    const hidden = defineModule({ name: 'hidden', providers: [Secret] })
    await assert.rejects(createApp({ modules: [hidden], use: [usesSecret] }), /app middleware "usesSecret" injects "Secret".*export it from "hidden"/)
    const shared = defineModule({ name: 'shared', providers: [Secret], exports: [Secret] })
    await createApp({ modules: [shared], use: [usesSecret] })
  })
})

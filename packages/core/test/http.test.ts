import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createApp, CurrentRequest, defineModule, defineRoute, defineService, DependencyError, HttpError, json } from '../src/index.ts'
import { listen } from '../src/node.ts'

const Users = defineService({
  name: 'Users',
  factory: () => {
    const rows = new Map([['00000000-0000-4000-8000-000000000001', { name: 'ann' }]])
    return {
      find: (id: string) => rows.get(id),
      add: (id: string, name: string) => void rows.set(id, { name }),
    }
  },
})

const getUser = defineRoute({
  method: 'GET',
  path: '/:id',
  params: z.object({ id: z.uuid() }),
  inject: { users: Users },
  handler: ({ params }, { users }) => {
    const user = users.find(params.id)
    if (!user) throw new HttpError(404, 'user not found')
    return user
  },
})

const createUser = defineRoute({
  method: 'POST',
  path: '/',
  body: z.object({ id: z.uuid(), name: z.string().min(1) }),
  inject: { users: Users },
  handler: ({ body }, { users }) => {
    users.add(body.id, body.name)
    return json({ id: body.id }, 201)
  },
})

const search = defineRoute({
  method: 'GET',
  path: '/search',
  query: z.object({ q: z.string(), limit: z.coerce.number().int().max(50).default(10) }),
  handler: ({ query }) => query,
})

const users = defineModule({ name: 'users', prefix: '/users', providers: [Users], routes: [search, getUser, createUser] })

const call = (app: { fetch(r: Request): Promise<Response> }, method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://test${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }))

describe('routes', () => {
  test('validated params reach the handler', async () => {
    const app = await createApp({ modules: [users] })
    const res = await call(app, 'GET', '/users/00000000-0000-4000-8000-000000000001')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { name: 'ann' })
  })

  test('invalid params give 400 with the issues', async () => {
    const app = await createApp({ modules: [users] })
    const res = await call(app, 'GET', '/users/nope')
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'validation_failed')
    assert.equal(body.where, 'params')
    assert.equal(body.issues[0].path, 'id')
  })

  test('query is parsed and coerced by the schema', async () => {
    const app = await createApp({ modules: [users] })
    assert.deepEqual(await (await call(app, 'GET', '/users/search?q=an&limit=5')).json(), { q: 'an', limit: 5 })
    assert.equal((await call(app, 'GET', '/users/search?q=an&limit=500')).status, 400)
  })

  test('JSON body is validated; custom status through json()', async () => {
    const app = await createApp({ modules: [users] })
    const id = '00000000-0000-4000-8000-000000000002'
    const res = await call(app, 'POST', '/users', { id, name: 'bob' })
    assert.equal(res.status, 201)
    assert.deepEqual(await (await call(app, 'GET', `/users/${id}`)).json(), { name: 'bob' })
    assert.equal((await call(app, 'POST', '/users', { id, name: '' })).status, 400)
    assert.equal((await call(app, 'POST', '/users', '{not json')).status, 400)
  })

  test('HttpError sets the status', async () => {
    const app = await createApp({ modules: [users] })
    const res = await call(app, 'GET', '/users/00000000-0000-4000-8000-000000000009')
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'user not found' })
  })

  test('undefined gives 204, a Response passes through', async () => {
    const m = defineModule({
      name: 'misc',
      routes: [
        defineRoute({ method: 'DELETE', path: '/thing', handler: () => undefined }),
        defineRoute({ method: 'GET', path: '/text', handler: () => new Response('hi', { headers: { 'content-type': 'text/plain' } }) }),
      ],
    })
    const app = await createApp({ modules: [m] })
    assert.equal((await call(app, 'DELETE', '/thing')).status, 204)
    assert.equal(await (await call(app, 'GET', '/text')).text(), 'hi')
  })

  test('unexpected errors give a plain 500 and are reported', async () => {
    const reported: unknown[] = []
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'GET', path: '/boom', handler: () => { throw new Error('secret detail') } })] })
    const app = await createApp({ modules: [m], onError: (e) => void reported.push(e) })
    const res = await call(app, 'GET', '/boom')
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal_error' })
    assert.equal((reported[0] as Error).message, 'secret detail')
  })

  test('unknown routes give 404', async () => {
    const app = await createApp({ modules: [users] })
    assert.equal((await call(app, 'GET', '/nowhere')).status, 404)
  })

  test('the app lists its routes with full paths', async () => {
    const app = await createApp({ modules: [users] })
    assert.deepEqual(app.routes.map((r) => `${r.method} ${r.path}`), ['GET /users/search', 'GET /users/:id', 'POST /users'])
  })
})

describe('request scope in routes', () => {
  test('request-scoped services see the current request and are disposed', async () => {
    const disposed: string[] = []
    const RequestId = defineService({
      name: 'RequestId',
      scope: 'request',
      inject: { req: CurrentRequest },
      factory: ({ req }) => req.headers.get('x-request-id') ?? 'none',
      onDestroy: (id) => void disposed.push(id),
    })
    const m = defineModule({
      name: 'm',
      providers: [RequestId],
      routes: [defineRoute({ method: 'GET', path: '/id', inject: { id: RequestId }, handler: (_, { id }) => ({ id }) })],
    })
    const app = await createApp({ modules: [m] })
    const res = await app.fetch(new Request('http://test/id', { headers: { 'x-request-id': 'r-1' } }))
    assert.deepEqual(await res.json(), { id: 'r-1' })
    assert.deepEqual(disposed, ['r-1'])
  })
})

describe('boot-time route checks', () => {
  test('a route cannot inject a service its module cannot see', async () => {
    const m = defineModule({ name: 'm', routes: [getUser] })
    await assert.rejects(createApp({ modules: [m] }), (e) => e instanceof DependencyError && /route "GET \/:id" in module "m" injects "Users"/.test(e.message))
  })

  test('the same method and path twice', async () => {
    const r = defineRoute({ method: 'GET', path: '/x', handler: () => 1 })
    await assert.rejects(createApp({ modules: [defineModule({ name: 'a', routes: [r] }), defineModule({ name: 'b', routes: [r] })] }), /GET \/x is defined in both "a" and "b"/)
  })
})

describe('node', () => {
  test('listen() serves the app over real HTTP', async () => {
    const app = await createApp({ modules: [users] })
    const server = await listen(app, { port: 0, handleSignals: false })
    try {
      const res = await fetch(`http://localhost:${server.port}/users/search?q=x`)
      assert.deepEqual(await res.json(), { q: 'x', limit: 10 })
    } finally {
      await server.close()
    }
  })
})

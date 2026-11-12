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
  app.fetch(
    new Request(`http://test${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

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
    assert.deepEqual(await res.json(), { error: 'not_found', message: 'user not found' })
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
    assert.deepEqual(await res.json(), { error: 'internal_error', message: 'internal server error' })
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
    await assert.rejects(createApp({ modules: [defineModule({ name: 'a', routes: [r] }), defineModule({ name: 'b', routes: [r] })] }), /GET \/x clashes with GET \/x: defined in both "a" and "b"/)
  })

  test('routes that differ only in param names clash', async () => {
    const a = defineRoute({ method: 'GET', path: '/u/:id', handler: () => 1 })
    const b = defineRoute({ method: 'GET', path: '/u/:userId', handler: () => 2 })
    await assert.rejects(createApp({ modules: [defineModule({ name: 'm', routes: [a, b] })] }), /GET \/u\/:userId clashes with GET \/u\/:id: defined twice in "m"/)
  })
})

describe('request body', () => {
  const id = '00000000-0000-4000-8000-000000000003'
  const post = (app: { fetch(r: Request): Promise<Response> }, init: RequestInit) => app.fetch(new Request('http://x/users', { method: 'POST', ...init }))

  test('a non-JSON content type gets 415 (no CSRF via simple requests)', async () => {
    const app = await createApp({ modules: [users] })
    const res = await post(app, { body: JSON.stringify({ id, name: 'eve' }), headers: { 'content-type': 'text/plain' } })
    assert.equal(res.status, 415)
    assert.equal((await res.json()).error, 'unsupported_media_type')
    assert.equal((await post(app, { body: JSON.stringify({ id, name: 'eve' }), headers: { 'content-type': 'application/merge-patch+json; charset=utf-8' } })).status, 201)
  })

  test('a body over bodyLimit gets 413, with or without Content-Length', async () => {
    const app = await createApp({ modules: [users], bodyLimit: 64 })
    const big = JSON.stringify({ id, name: 'x'.repeat(100) })
    const res = await post(app, { body: big, headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 413)
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(big)), c.close()) })
    const chunked = await post(app, { body: stream, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit)
    assert.equal(chunked.status, 413)
  })

  test('invalid JSON gets 400', async () => {
    const app = await createApp({ modules: [users] })
    const res = await post(app, { body: '{oops', headers: { 'content-type': 'application/json' } })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: 'bad_request', message: 'request body is not valid JSON' })
  })
})

describe('request body edge cases', () => {
  test('no body and no Content-Type reaches the schema', async () => {
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'POST', path: '/opt', body: z.object({ a: z.number() }).optional(), handler: ({ body }) => ({ got: body ?? null }) })] })
    const app = await createApp({ modules: [m] })
    const res = await app.fetch(new Request('http://x/opt', { method: 'POST' }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { got: null })
  })

  test('an invalid bodyLimit fails at boot', async () => {
    await assert.rejects(createApp({ modules: [users], bodyLimit: Number.NaN }), /bodyLimit must be/)
    await assert.rejects(createApp({ modules: [users], bodyLimit: -1 }), /bodyLimit must be/)
    await createApp({ modules: [users], bodyLimit: Infinity })
  })

  test('constrained params with different patterns do not clash', async () => {
    const a = defineRoute({ method: 'GET', path: '/f/:id{[0-9]+}', handler: () => 'id' })
    const b = defineRoute({ method: 'GET', path: '/f/:slug{[a-z-]+}', handler: () => 'slug' })
    const app = await createApp({ modules: [defineModule({ name: 'm', routes: [a, b] })] })
    assert.equal(await (await app.fetch(new Request('http://x/f/12'))).json(), 'id')
    assert.equal(await (await app.fetch(new Request('http://x/f/ab-c'))).json(), 'slug')
  })
})

describe('errors', () => {
  test('HttpError refuses non-error statuses at the throw site', () => {
    assert.throws(() => new HttpError(204, 'nope'), RangeError)
    assert.equal(new HttpError(418, 'teapot').code, 'http_418')
    assert.equal(new HttpError(409, 'taken', undefined, 'email_taken').code, 'email_taken')
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

  test('an empty POST without Content-Type reaches an optional body schema over real HTTP', async () => {
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'POST', path: '/opt', body: z.object({ a: z.number() }).optional(), handler: ({ body }) => ({ got: body ?? null }) })] })
    const app = await createApp({ modules: [m] })
    const server = await listen(app, { port: 0, handleSignals: false })
    try {
      const res = await fetch(`http://localhost:${server.port}/opt`, { method: 'POST' })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { got: null })
      const form = await fetch(`http://localhost:${server.port}/opt`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'text/plain' } })
      assert.equal(form.status, 415)
    } finally {
      await server.close()
    }
  })

  test('listen() rejects when the port is taken', async () => {
    const app = await createApp({ modules: [users] })
    const first = await listen(app, { port: 0, handleSignals: false })
    try {
      await assert.rejects(listen(app, { port: first.port, handleSignals: false }), /EADDRINUSE/)
    } finally {
      await first.close()
    }
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { BolideError, createApp, defineModule, defineRoute, openApiDocument } from '../src/index.ts'

const User = z.object({ id: z.uuid(), name: z.string() })

const routes = [
  defineRoute({
    method: 'GET',
    path: '/:id',
    params: z.object({ id: z.uuid() }),
    response: User,
    summary: 'Get a user',
    handler: ({ params }) => ({ id: params.id, name: 'ann' }),
  }),
  defineRoute({
    method: 'GET',
    path: '/',
    query: z.object({ q: z.string().optional(), limit: z.coerce.number().default(10) }),
    response: z.array(User),
    handler: () => [],
  }),
  defineRoute({
    method: 'POST',
    path: '/',
    body: User.omit({ id: true }),
    response: User,
    status: 201,
    tags: ['admin'],
    operationId: 'createUser',
    handler: ({ body }) => ({ id: '00000000-0000-4000-8000-000000000001', ...body }),
  }),
  defineRoute({ method: 'DELETE', path: '/:id/sessions/:sid', handler: () => undefined }),
]
const users = defineModule({ name: 'users', prefix: '/users', routes })
const info = { title: 'Test API', version: '1.0.0' }

describe('openapi', () => {
  test('paths, parameters, bodies and responses come from the route schemas', async () => {
    const app = await createApp({ modules: [users] })
    const doc = openApiDocument(app.routes, { info }) as any
    assert.equal(doc.openapi, '3.1.0')
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/users', '/users/{id}', '/users/{id}/sessions/{sid}'])

    const get = doc.paths['/users/{id}'].get
    assert.equal(get.operationId, 'getUsersById')
    assert.equal(get.summary, 'Get a user')
    assert.deepEqual(get.tags, ['users'])
    assert.deepEqual(get.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid', pattern: get.parameters[0].schema.pattern } }])
    assert.deepEqual(get.responses['200'].content['application/json'].schema.required, ['id', 'name'])
    assert.ok(get.responses['400'])
    assert.equal(get.responses['415'], undefined)

    const list = doc.paths['/users'].get
    assert.deepEqual(
      list.parameters.map((p: any) => [p.name, p.in, p.required]),
      [['q', 'query', false], ['limit', 'query', false]],
    )

    const create = doc.paths['/users'].post
    assert.equal(create.operationId, 'createUser')
    assert.deepEqual(create.tags, ['admin'])
    assert.deepEqual(create.requestBody.content['application/json'].schema.properties, { name: { type: 'string' } })
    assert.ok(create.responses['201'])
    assert.ok(create.responses['413'] && create.responses['415'])

    const del = doc.paths['/users/{id}/sessions/{sid}'].delete
    assert.equal(del.operationId, 'deleteUsersByIdSessionsBySid')
    assert.deepEqual(del.parameters.map((p: any) => p.name), ['id', 'sid'])
    assert.equal(del.requestBody, undefined)
  })

  test('createApp serves the document', async () => {
    const app = await createApp({ modules: [users], openapi: { info, path: '/docs.json' } })
    const res = await app.fetch(new Request('http://x/docs.json'))
    assert.equal(res.headers.get('content-type'), 'application/json')
    assert.equal((await res.json()).info.title, 'Test API')
    assert.equal((await app.fetch(new Request('http://x/openapi.json'))).status, 404)
    assert.equal((await app.fetch(new Request('http://x/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"bo"}' }))).status, 201)
  })

  test('a route on the document path fails at boot', async () => {
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'GET', path: '/openapi.json', handler: () => 1 })] })
    await assert.rejects(createApp({ modules: [m], openapi: { info } }), (e) => e instanceof BolideError && /also a route in module "m"/.test(e.message))
  })

  test('a schema without a JSON Schema converter is listed with an empty schema', async () => {
    const opaque = { '~standard': { version: 1, vendor: 'x', validate: (v: unknown) => ({ value: v }) } } as const
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'POST', path: '/x', body: opaque, handler: () => 1 })] })
    const app = await createApp({ modules: [m] })
    const doc = openApiDocument(app.routes, { info }) as any
    assert.deepEqual(doc.paths['/x'].post.requestBody.content['application/json'].schema, {})
  })

  test('responses are documented as sent: defaults stay optional', async () => {
    const m = defineModule({
      name: 'm',
      routes: [defineRoute({ method: 'GET', path: '/page', response: z.object({ page: z.number().default(1) }), handler: () => ({}) })],
    })
    const doc = openApiDocument((await createApp({ modules: [m] })).routes, { info }) as any
    const schema = doc.paths['/page'].get.responses['200'].content['application/json'].schema
    assert.ok(!(schema.required ?? []).includes('page'))
  })

  test('a schema that cannot become JSON Schema names the route', async () => {
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'POST', path: '/d', body: z.object({ at: z.date() }), handler: () => 1 })] })
    const app = await createApp({ modules: [m] })
    assert.throws(() => openApiDocument(app.routes, { info }), (e) => e instanceof BolideError && /body of POST \/d/.test(e.message))
  })

  test('duplicate operationIds fail', async () => {
    const m = defineModule({
      name: 'm',
      routes: [
        defineRoute({ method: 'GET', path: '/users-list', handler: () => 1 }),
        defineRoute({ method: 'GET', path: '/users/list', handler: () => 2 }),
      ],
    })
    const app = await createApp({ modules: [m] })
    assert.throws(() => openApiDocument(app.routes, { info }), /both have operationId "getUsersList"/)
  })

  test('optional bodies are not required; body routes document both 400 shapes', async () => {
    const m = defineModule({
      name: 'm',
      routes: [defineRoute({ method: 'POST', path: '/opt', body: z.object({ a: z.number() }).optional(), handler: () => 1 })],
    })
    const doc = openApiDocument((await createApp({ modules: [m] })).routes, { info }) as any
    const op = doc.paths['/opt'].post
    assert.equal(op.requestBody.required, false)
    assert.equal(op.responses['400'].content['application/json'].schema.oneOf.length, 2)
  })

  test('openapi.path must start with a slash; the document wins over param routes', async () => {
    await assert.rejects(createApp({ modules: [users], openapi: { info, path: 'openapi.json' } }), /must start with "\/"/)
    const m = defineModule({ name: 'm', routes: [defineRoute({ method: 'GET', path: '/:slug', handler: () => 'page' })] })
    const app = await createApp({ modules: [m], openapi: { info } })
    assert.equal((await (await app.fetch(new Request('http://x/openapi.json'))).json()).openapi, '3.1.0')
    assert.equal(await (await app.fetch(new Request('http://x/about'))).json(), 'page')
  })
})

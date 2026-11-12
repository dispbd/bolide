import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createApp, createLogger, defineModule, defineRoute, noopTracer, otelTracer, Tracer, type LogRecord, type OtelApi } from '../src/index.ts'

/** A stand-in for @opentelemetry/api that records what the adapter does. */
function fakeOtel() {
  const spans: { name: string; kind?: number; attributes: Record<string, unknown>; parent: unknown; errors: unknown[]; status?: number; ended: boolean }[] = []
  // Like OpenTelemetry's context manager on Node: the active span follows async calls.
  const als = new AsyncLocalStorage<unknown>()
  const api: OtelApi = {
    context: { active: () => als.getStore() ?? 'root' },
    propagation: {
      extract: (ctx, headers, getter) => (getter.get(headers, 'traceparent') ? `remote:${getter.get(headers, 'traceparent')}` : ctx),
    },
    trace: {
      getTracer: () => ({
        startActiveSpan: (name, options, ctx, fn) => {
          const record = { name, kind: options.kind, attributes: { ...options.attributes }, parent: ctx, errors: [] as unknown[], status: undefined as number | undefined, ended: false }
          spans.push(record)
          return als.run(name, () =>
            fn({
              spanContext: () => ({ traceId: 'trace-1' }),
              setAttribute: (k, v) => void (record.attributes[k] = v),
              updateName: (n) => void (record.name = n),
              recordException: (e) => void record.errors.push(e),
              setStatus: (s) => void (record.status = s.code),
              end: () => void (record.ended = true),
            }),
          ) as never
        },
      }),
    },
  }
  return { api, spans }
}

describe('tracing', () => {
  test('noopTracer just runs the callback', async () => {
    assert.equal(await noopTracer.span('x', () => 3), 3)
  })

  test('each request is a server span named after its route, continuing an incoming trace', async () => {
    const { api, spans } = fakeOtel()
    const records: LogRecord[] = []
    const route = defineRoute({ method: 'GET', path: '/users/:id', inject: { tracer: Tracer }, handler: ({ params }, { tracer }) => tracer.span('load user', () => ({ id: params.id })) })
    const app = await createApp({ modules: [defineModule({ name: 'm', routes: [route] })], tracer: otelTracer(api), logger: createLogger({ write: (r) => void records.push(r) }) })
    const res = await app.fetch(new Request('http://x/users/7', { headers: { traceparent: '00-abc-def-01' } }))
    assert.equal(res.status, 200)
    const [server, inner] = spans
    assert.equal(server!.name, 'GET /users/:id')
    assert.equal(server!.kind, 1)
    assert.equal(server!.parent, 'remote:00-abc-def-01')
    assert.deepEqual(server!.attributes, { 'http.request.method': 'GET', 'url.path': '/users/7', 'http.response.status_code': 200, 'http.route': '/users/:id' })
    assert.equal(inner!.name, 'load user')
    assert.equal(inner!.parent, 'GET', 'the handler span is a child of the request span')
    assert.ok(spans.every((s) => s.ended))
    assert.equal(records.at(-1)!.fields.traceId, 'trace-1')
  })

  test('unexpected errors are recorded on the request span', async () => {
    const { api, spans } = fakeOtel()
    const route = defineRoute({ method: 'GET', path: '/boom', handler: () => {
      throw new Error('boom')
    } })
    const app = await createApp({ modules: [defineModule({ name: 'm', routes: [route] })], tracer: otelTracer(api), logger: createLogger({ write: () => {} }) })
    assert.equal((await app.fetch(new Request('http://x/boom'))).status, 500)
    assert.equal((spans[0]!.errors[0] as Error).message, 'boom')
    assert.equal(spans[0]!.status, 2)
    assert.equal(spans[0]!.attributes['http.response.status_code'], 500)
  })

  test('the adapter records and rethrows errors from the callback', async () => {
    const { api, spans } = fakeOtel()
    await assert.rejects(otelTracer(api).span('work', () => Promise.reject(new Error('nope'))), /nope/)
    assert.deepEqual([spans[0]!.status, spans[0]!.ended], [2, true])
  })
})

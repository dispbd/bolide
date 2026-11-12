import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { defineShape, defineTable, t } from '@bolide/data'
import { electricTransport } from '../src/electric.ts'
import type { SyncChange } from '../src/index.ts'

const todos = defineTable('todos', { id: t.uuid().primaryKey(), title: t.text() })
const all = defineShape('todos.all', todos)

describe('electricTransport', () => {
  test('turns Electric messages into changes, txids and up-to-date', async () => {
    const asked: string[] = []
    const id = crypto.randomUUID()
    let calls = 0
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input))
      const headers = { 'electric-handle': 'h1', 'electric-offset': `0_${calls}`, 'electric-schema': '{"id":{"type":"uuid"},"title":{"type":"text"}}', 'electric-cursor': '1', 'content-type': 'application/json' }
      if (calls++ === 0) {
        return new Response(
          JSON.stringify([
            { key: `"public"."todos"/"${id}"`, value: { id, title: 'a' }, headers: { operation: 'insert', txids: [41] } },
            { headers: { control: 'up-to-date' } },
          ]),
          { headers: { ...headers, 'electric-up-to-date': '' } },
        )
      }
      // Live request: hold it open until the stream is stopped.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as typeof fetch
    const got: { changes: SyncChange[]; txids: readonly string[] }[] = []
    let upToDate!: () => void
    const ready = new Promise<void>((r) => (upToDate = r))
    const stop = electricTransport({ origin: 'http://app.test', fetch: fakeFetch }).subscribe(
      { url: '/api/data/shape/todos.all', shape: all, headers: () => ({ authorization: 'Bearer x' }) },
      { changes: (changes, txids) => got.push({ changes, txids }), upToDate, reset: () => {}, error: (e) => assert.fail(String(e)) },
    )
    await ready
    stop()
    assert.deepEqual(got, [{ changes: [{ type: 'insert', row: { id, title: 'a' } }], txids: ['41'] }])
    const first = new URL(asked[0]!)
    assert.equal(first.origin + first.pathname, 'http://app.test/api/data/shape/todos.all')
    assert.equal(first.searchParams.get('table'), null, 'the browser never names a table')
  })
})

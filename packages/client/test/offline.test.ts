import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineMutator, defineShape, defineTable, t } from '@bolide/data'
import { createClient, memoryStorage, MutationRejected, type ClientStorage, type SyncPosition, type SyncSink, type SyncTransport } from '../src/index.ts'

const todos = defineTable('todos', { id: t.uuid().primaryKey(), title: t.text(), ownerId: t.uuid() })
const mine = defineShape('todos.mine', todos, { where: ({ userId }) => (userId ? { ownerId: userId } : false) })
const create = defineMutator({
  name: 'todos.create',
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  run: async ({ tx, input, userId }) => void (await tx.insert(todos, { ...input, ownerId: userId! })),
})
const ann = crypto.randomUUID()
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A browser session: a fake stream and a fake server, sharing `storage` with the sessions before it. */
function session(storage: ClientStorage, opts: { user?: string; answer?: (body: { id: string; name: string }) => Response | 'offline' } = {}) {
  const sinks = new Map<string, SyncSink>()
  const resumed: (SyncPosition | undefined)[] = []
  const transport: SyncTransport = {
    subscribe: ({ shape, resume }, sink) => {
      sinks.set(shape.name, sink)
      resumed.push(resume)
      return () => void sinks.delete(shape.name)
    },
  }
  const sent: string[] = []
  const client = createClient({
    transport,
    mutators: [create],
    userId: () => opts.user ?? ann,
    storage,
    confirmTimeout: 20,
    retry: { initial: 1, max: 2 },
    onStorageError: (e) => assert.fail(String(e)),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { id: string; name: string }
      const res = (opts.answer ?? (() => Response.json({ txid: '1' })))(body)
      if (res === 'offline') throw new TypeError('fetch failed')
      sent.push(body.id)
      return res
    },
  })
  const view = client.shape(mine)
  view.subscribe(() => {})
  return { client, view, sinks, resumed, sent }
}

const row = (id: string, title: string) => ({ id, title, owner_id: ann })

describe('offline mode', () => {
  test('a reload shows the saved rows at once and resumes the stream where they were saved', async () => {
    const storage = memoryStorage()
    const first = session(storage)
    await wait()
    const id = crypto.randomUUID()
    const sink = first.sinks.get('todos.mine')!
    sink.changes([{ type: 'insert', row: row(id, 'Buy milk') }], [])
    sink.upToDate()
    sink.position!({ offset: '42_0', handle: 'h1' })
    await first.view.ready
    await first.client.saved()
    first.client.close()

    const second = session(storage)
    await second.view.ready
    assert.equal(second.view.status, 'ready', 'ready from storage, before the server answers')
    assert.deepEqual(second.view.rows().map((r) => r.title), ['Buy milk'])
    await wait()
    assert.deepEqual(second.resumed, [{ offset: '42_0', handle: 'h1' }])
    second.client.close()
  })

  test('changes made offline survive a reload and are sent, in order, with their ids', async () => {
    const storage = memoryStorage()
    const offline = session(storage, { answer: () => 'offline' })
    const a = offline.client.mutate(create, { id: crypto.randomUUID(), title: 'one' })
    const b = offline.client.mutate(create, { id: crypto.randomUUID(), title: 'two' })
    await b.applied
    await wait(5)
    assert.deepEqual(offline.client.status(), { online: false, pending: 2 })
    await offline.client.saved()
    offline.client.close()
    await assert.rejects(a.done, (e) => e instanceof MutationRejected && e.code === 'closed')

    const back = session(storage)
    const restored = back.client.pending()
    await wait()
    assert.deepEqual(back.view.rows().map((r) => r.title), ['one', 'two'], 'shown again before the server confirms')
    await wait(5)
    assert.deepEqual(back.sent, [a.id, b.id], 'same ids, so the server applies each once')
    await Promise.all(back.client.pending().map((m) => m.done))
    assert.equal(restored.length, 0, 'restoring is asynchronous')
    assert.deepEqual(back.client.status(), { online: true, pending: 0 })
    await back.client.saved()
    assert.equal([...storage.data.keys()].filter((k) => k.startsWith('mutation:')).length, 0, 'confirmed ones are forgotten')
    back.client.close()
  })

  test('a mutation the server refuses is forgotten too', async () => {
    const storage = memoryStorage()
    const s = session(storage, { answer: () => Response.json({ error: 'forbidden', message: 'no' }, { status: 403 }) })
    await assert.rejects(s.client.mutate(create, { id: crypto.randomUUID(), title: 'x' }).done, /no/)
    await s.client.saved()
    assert.deepEqual([...storage.data.keys()].filter((k) => k.startsWith('mutation:')), [])
    s.client.close()
  })

  test('saved data belongs to the user who saved it', async () => {
    const storage = memoryStorage()
    const first = session(storage, { answer: () => 'offline' })
    first.client.mutate(create, { id: crypto.randomUUID(), title: 'secret' }).done.catch(() => {})
    await wait()
    const sink = first.sinks.get('todos.mine')!
    sink.changes([{ type: 'insert', row: row(crypto.randomUUID(), 'mine') }], [])
    sink.upToDate()
    sink.position!({ offset: '1_0', handle: 'h' })
    await wait(5)
    await first.client.saved()
    first.client.close()

    const other = session(storage, { user: crypto.randomUUID() })
    await wait(5)
    assert.deepEqual(other.view.rows(), [])
    assert.equal(other.view.status, 'loading')
    assert.deepEqual(other.sent, [])
    assert.deepEqual(other.resumed, [undefined])
    other.client.close()
  })

  test('a must-refetch drops the saved rows', async () => {
    const storage = memoryStorage()
    const s = session(storage)
    await wait()
    const sink = s.sinks.get('todos.mine')!
    sink.changes([{ type: 'insert', row: row(crypto.randomUUID(), 'old') }], [])
    sink.upToDate()
    sink.position!({ offset: '1_0', handle: 'h' })
    await s.client.saved()
    sink.reset()
    await s.client.saved()
    assert.deepEqual([...storage.data.keys()].filter((k) => k.startsWith('shape:')), [])
    s.client.close()
  })
})

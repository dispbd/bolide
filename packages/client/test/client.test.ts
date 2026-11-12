import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineMutator, defineShape, defineTable, MutatorError, t } from '@bolide/data'
import { createClient, MutationRejected, type SyncSink, type SyncTransport } from '../src/index.ts'

const todos = defineTable('todos', { id: t.uuid().primaryKey(), title: t.text(), done: t.boolean().default(false), ownerId: t.uuid() })
const mine = defineShape('todos.mine', todos, { where: ({ userId }) => (userId ? { ownerId: userId } : false) })

const create = defineMutator({
  name: 'todos.create',
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  async run({ tx, input, userId }) {
    await tx.insert(todos, { id: input.id, title: input.title, ownerId: userId! })
  },
})
const toggle = defineMutator({
  name: 'todos.toggle',
  input: z.object({ id: z.uuid() }),
  async run({ tx, input }) {
    const todo = await tx.get(todos, input.id)
    if (!todo) throw new MutatorError('not_found', 'no such todo')
    await tx.update(todos, input.id, { done: !todo.done })
  },
})
const giveAway = defineMutator({
  name: 'todos.give',
  input: z.object({ id: z.uuid(), to: z.uuid() }),
  async run({ tx, input }) {
    await tx.update(todos, input.id, { ownerId: input.to })
  },
})
const archive = defineMutator({ name: 'todos.archive', input: z.object({}), local: false, run: () => {} })

const ann = crypto.randomUUID()
const bob = crypto.randomUUID()
const tick = () => new Promise((r) => setTimeout(r, 0))

/** A fake server: answers mutations with `answer`, and syncs back what it accepted. */
function setup(answer: (name: string, input: Record<string, unknown>) => Response | Promise<Response> | 'offline' = () => Response.json({ txid: '1' })) {
  const sinks = new Map<string, SyncSink>()
  let stopped = 0
  const transport: SyncTransport = {
    subscribe: ({ shape }, sink) => {
      sinks.set(shape.name, sink)
      return () => void stopped++
    },
  }
  const sent: string[] = []
  const rejected: string[] = []
  const client = createClient({
    transport,
    mutators: [create, toggle, giveAway, archive],
    userId: () => ann,
    confirmTimeout: 50,
    retry: { initial: 1, max: 4 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { name: string; input: Record<string, unknown> }
      const res = await answer(body.name, body.input)
      if (res === 'offline') throw new TypeError('fetch failed')
      sent.push(body.name)
      return res
    },
    onRejected: (m, e) => rejected.push(`${m.name}: ${e.code}`),
  })
  const view = client.shape(mine)
  view.subscribe(() => {})
  const sync = (changes: Parameters<SyncSink['changes']>[0], txids: string[] = []) => sinks.get('todos.mine')!.changes(changes, txids)
  return { client, view, sync, sinks, sent, rejected, stopped: () => stopped }
}

const row = (id: string, title: string, done = false, ownerId = ann) => ({ id, title, done, owner_id: ownerId })

describe('client', () => {
  test('a mutation shows at once and stays when the server confirms it', async () => {
    const { client, view, sync, sinks } = setup()
    sinks.get('todos.mine')!.upToDate()
    await view.ready
    const id = crypto.randomUUID()
    const m = client.mutate(create, { id, title: 'Buy milk' })
    await m.applied
    assert.deepEqual(view.rows(), [{ id, title: 'Buy milk', done: false, ownerId: ann }])
    await tick()
    assert.equal(m.status, 'sent')
    sync([{ type: 'insert', row: row(id, 'Buy milk') }], ['1'])
    await m.done
    assert.equal(m.status, 'confirmed')
    assert.deepEqual(view.rows(), [{ id, title: 'Buy milk', done: false, ownerId: ann }])
    assert.equal(client.pending().length, 0)
  })

  test('a rejection rolls the change back and every later change that built on it', async () => {
    const { client, view, sync, rejected } = setup((name) => (name === 'todos.toggle' ? Response.json({ error: 'forbidden', message: 'not yours' }, { status: 403 }) : Response.json({ txid: '9' })))
    const id = crypto.randomUUID()
    sync([{ type: 'insert', row: row(id, 'Old') }])
    await tick()
    const m = client.mutate(toggle, { id })
    await m.applied
    assert.equal(view.rows()[0]!.done, true, 'optimistic')
    await assert.rejects(m.done, (e) => e instanceof MutationRejected && e.code === 'forbidden' && e.status === 403 && e.message === 'not yours')
    await tick()
    assert.equal(view.rows()[0]!.done, false, 'rolled back')
    assert.deepEqual(rejected, ['todos.toggle: forbidden'])
  })

  test('pending changes are replayed over new rows from the server', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { client, view, sync } = setup(async () => (await gate, Response.json({ txid: '5' })))
    const id = crypto.randomUUID()
    sync([{ type: 'insert', row: row(id, 'v1') }])
    const m = client.mutate(toggle, { id })
    await m.applied
    assert.deepEqual(view.rows().map((r) => [r.title, r.done]), [['v1', true]])
    // Someone else renames it meanwhile: the toggle is replayed on top.
    sync([{ type: 'update', row: { id, title: 'v2' } }], ['4'])
    await tick()
    assert.deepEqual(view.rows().map((r) => [r.title, r.done]), [['v2', true]])
    release()
    await tick()
    sync([{ type: 'update', row: { id, done: true } }], ['5'])
    await m.done
    assert.deepEqual(view.rows().map((r) => [r.title, r.done]), [['v2', true]])
  })

  test('a rejected insert takes the dependent toggle with it', async () => {
    const { client, view } = setup((name) => (name === 'todos.create' ? Response.json({ error: 'conflict', message: 'taken' }, { status: 409 }) : Response.json({ error: 'not_found', message: 'gone' }, { status: 404 })))
    const id = crypto.randomUUID()
    const a = client.mutate(create, { id, title: 'x' })
    const b = client.mutate(toggle, { id })
    await b.applied
    assert.deepEqual(view.rows().map((r) => r.done), [true])
    await assert.rejects(a.done, /taken/)
    await assert.rejects(b.done, /gone/)
    await tick()
    assert.deepEqual(view.rows(), [])
  })

  test('mutations wait out a lost connection and are sent in order', async () => {
    let failures = 2
    const { client, sent, sync } = setup(() => (failures-- > 0 ? 'offline' : Response.json({ txid: String(10 - failures) })))
    const id = crypto.randomUUID()
    const a = client.mutate(create, { id, title: 'x' })
    const b = client.mutate(toggle, { id })
    await b.applied
    sync([{ type: 'insert', row: row(id, 'x', true) }], ['11', '12'])
    await Promise.all([a.done, b.done])
    assert.deepEqual(sent, ['todos.create', 'todos.toggle'])
  })

  test('a shape shows optimistic rows only if its rule would', async () => {
    const { client, view, sync } = setup()
    const id = crypto.randomUUID()
    sync([{ type: 'insert', row: row(id, 'mine') }])
    await tick()
    const m = client.mutate(giveAway, { id, to: bob })
    await m.applied
    assert.deepEqual(view.rows(), [], 'given away: no longer in "mine"')
    await m.done // no txid arrives: dropped after confirmTimeout
  })

  test('bad input and failing local runs are refused before anything is sent', async () => {
    const { client, sent } = setup()
    await assert.rejects(client.mutate(create, { id: 'nope', title: '' }).done, (e) => e instanceof MutationRejected && e.code === 'invalid_input' && e.status === 0)
    await assert.rejects(client.mutate(toggle, { id: crypto.randomUUID() }).done, (e) => e instanceof MutationRejected && e.code === 'not_found')
    assert.throws(() => client.mutate(defineMutator({ name: 'other', input: z.object({}), run: () => {} }), {}), /not in createClient/)
    await tick()
    assert.deepEqual(sent, [])
  })

  test('server-only mutators skip the local run; servers errors are retried', async () => {
    let calls = 0
    const { client, sent } = setup(() => (++calls === 1 ? new Response('oops', { status: 503 }) : Response.json({ txid: '3' })))
    await client.mutate(archive, {}).done
    assert.deepEqual([calls, sent], [2, ['todos.archive', 'todos.archive']])
  })

  test('the last unsubscribe stops the stream', async () => {
    const { client, stopped } = setup()
    const v = client.shape(mine)
    const off = v.subscribe(() => {})
    assert.equal(stopped(), 0)
    off()
    assert.equal(stopped(), 0, 'another subscriber is still there')
    client.close()
    assert.equal(stopped(), 1)
  })

  test('a stream outlives an unsubscribe that is followed at once by a subscribe', async () => {
    const { client, sinks, stopped } = setup()
    const other = defineShape('todos.all', todos)
    const v = client.shape(other)
    v.subscribe(() => {})()
    const off = v.subscribe(() => {}) // a remount in the same tick
    await tick()
    assert.equal(stopped(), 0, 'kept')
    assert.ok(sinks.has('todos.all'))
    off()
    await tick()
    assert.equal(stopped(), 1, 'stopped once nobody came back')
    client.close()
  })
})

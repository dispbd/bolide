import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, MutationRejected, type SyncSink } from '@bolide/client'
import { addTodo, mutators, myTodos, renameTodo, toggleTodo } from '../src/shared/schema.ts'

// The mutators run in the browser too: this checks them against the client's local store, without a server.
test('a todo shows at once, and the rules refuse what the server would', async () => {
  const me = crypto.randomUUID()
  let sink!: SyncSink
  const client = createClient({
    transport: { subscribe: (_, s) => ((sink = s), () => {}) },
    mutators,
    userId: () => me,
    fetch: async () => new Promise<Response>(() => {}), // the server never answers here
  })
  const view = client.shape(myTodos)
  view.subscribe(() => {})
  sink.upToDate()

  const id = crypto.randomUUID()
  await client.mutate(addTodo, { id, title: '  Buy milk ' }).applied
  await client.mutate(toggleTodo, { id }).applied
  assert.deepEqual(
    view.rows().map((t) => [t.title, t.done, t.ownerId]),
    [['Buy milk', true, me]],
  )

  // Someone else's todo arrives (it can't through this shape, but the rule must hold anyway).
  const theirs = crypto.randomUUID()
  sink.changes([{ type: 'insert', row: { id: theirs, title: 'x', done: false, owner_id: crypto.randomUUID(), created_at: new Date().toISOString() } }], [])
  await assert.rejects(client.mutate(renameTodo, { id: theirs, title: 'mine now' }).done, (e) => e instanceof MutationRejected && e.code === 'not_found')
  await assert.rejects(client.mutate(addTodo, { id: crypto.randomUUID(), title: ' ' }).done, (e) => e instanceof MutationRejected && e.code === 'invalid_input')
  client.close()
})

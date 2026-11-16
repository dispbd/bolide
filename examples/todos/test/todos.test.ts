import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, MutationRejected, type SyncSink } from '@bolide/client'
import { addTodo, createList, mutators, myLists, myTodos, renameTodo, toggleTodo } from '../src/shared/schema.ts'

// The mutators run in the browser too: this checks them against the client's local store, without a server.
test('a list and its todo show at once, and the rules refuse what they can tell', async () => {
  const me = crypto.randomUUID()
  const sinks = new Map<string, SyncSink>()
  const client = createClient({
    transport: { subscribe: ({ shape }, s) => (sinks.set(shape.name, s), () => {}) },
    mutators,
    userId: () => me,
    fetch: async () => new Promise<Response>(() => {}), // the server never answers here
  })
  const lists = client.shape(myLists)
  const todos = client.shape(myTodos)
  lists.subscribe(() => {})
  todos.subscribe(() => {})
  for (const s of sinks.values()) s.upToDate()

  const listId = crypto.randomUUID()
  await client.mutate(createList, { id: listId, name: ' Groceries ' }).applied
  const id = crypto.randomUUID()
  await client.mutate(addTodo, { id, listId, title: '  Buy milk ' }).applied
  await client.mutate(toggleTodo, { id }).applied
  assert.deepEqual(lists.rows().map((l) => l.name), ['Groceries'])
  assert.deepEqual(todos.rows().map((t) => [t.title, t.done, t.listId]), [['Buy milk', true, listId]])

  await assert.rejects(client.mutate(renameTodo, { id: crypto.randomUUID(), title: 'x' }).done, (e) => e instanceof MutationRejected && e.code === 'not_found')
  await assert.rejects(client.mutate(addTodo, { id: crypto.randomUUID(), listId, title: ' ' }).done, (e) => e instanceof MutationRejected && e.code === 'invalid_input')
  client.close()
})

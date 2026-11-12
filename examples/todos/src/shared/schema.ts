// Shared by the server and the browser: the table, who may read what, and every change the UI can make.
import { defineMutator, defineShape, defineTable, MutatorError, t, type MutatorTx } from '@bolide/data'
import * as v from 'valibot'

export const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid(),
  createdAt: t.timestamp().defaultNow(),
})

/** Each user syncs only their own todos. The server applies this rule; the browser can't widen it. */
export const myTodos = defineShape('todos.mine', todos, {
  where: ({ userId }) => (userId ? { ownerId: userId } : false),
})

// Any Standard Schema library works. Valibot is small enough for the browser bundle (about 1.5 KB here).
const id = v.pipe(v.string(), v.uuid())
const title = v.pipe(v.string(), v.trim(), v.minLength(1, 'a todo needs a title'), v.maxLength(200))

/** The todo, if it exists and belongs to the user. Someone else's todo looks the same as a missing one. */
async function own(tx: MutatorTx, id: string, userId: string | undefined) {
  const todo = await tx.get(todos, id)
  if (!todo || todo.ownerId !== userId) throw new MutatorError('not_found', 'no such todo')
  return todo
}

export const addTodo = defineMutator({
  name: 'todos.add',
  // The browser picks the id, so the new row has its final key at once.
  input: v.object({ id, title }),
  async run({ tx, input, userId }) {
    if (!userId) throw new MutatorError('forbidden', 'no user')
    await tx.insert(todos, { id: input.id, title: input.title, ownerId: userId })
  },
})

export const toggleTodo = defineMutator({
  name: 'todos.toggle',
  input: v.object({ id }),
  async run({ tx, input, userId }) {
    const todo = await own(tx, input.id, userId)
    await tx.update(todos, todo.id, { done: !todo.done })
  },
})

export const renameTodo = defineMutator({
  name: 'todos.rename',
  input: v.object({ id, title }),
  async run({ tx, input, userId }) {
    await own(tx, input.id, userId)
    await tx.update(todos, input.id, { title: input.title })
  },
})

export const removeTodo = defineMutator({
  name: 'todos.remove',
  input: v.object({ id }),
  async run({ tx, input, userId }) {
    await own(tx, input.id, userId)
    await tx.delete(todos, input.id)
  },
})

export const mutators = [addTodo, toggleTodo, renameTodo, removeTodo]

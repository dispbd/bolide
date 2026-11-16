// Shared by the server and the browser: the tables, who may read what, and every change the UI can make.
import { defineMutator, defineShape, defineTable, MutatorError, query, t, type MutatorTx } from '@bolide/data'
import * as v from 'valibot'

export const lists = defineTable('lists', {
  id: t.uuid().primaryKey(),
  name: t.text(),
  createdAt: t.timestamp().defaultNow(),
})

/** Who may see and change a list. The key is `listId:userId`, so a membership is one lookup. */
export const members = defineTable('members', {
  id: t.text().primaryKey(),
  listId: t.uuid().references(() => lists),
  userId: t.uuid(),
})

export const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  listId: t.uuid().references(() => lists),
  title: t.text(),
  done: t.boolean().default(false),
  createdAt: t.timestamp().defaultNow(),
})

// Each user syncs the lists they are a member of, and those lists' todos. The server applies these rules
// (the browser can't widen them) and reloads them when the user joins or leaves a list.
const mine = (userId: string) => query(members, 'listId', { userId })
export const myLists = defineShape('lists.mine', lists, { where: ({ userId }) => (userId ? { id: { in: mine(userId) } } : false) })
export const myTodos = defineShape('todos.mine', todos, { where: ({ userId }) => (userId ? { listId: { in: mine(userId) } } : false) })

// Any Standard Schema library works. Valibot is small enough for the browser bundle (about 1.5 KB here).
const id = v.pipe(v.string(), v.uuid())
const title = v.pipe(v.string(), v.trim(), v.minLength(1, 'a todo needs a title'), v.maxLength(200))
const name = v.pipe(v.string(), v.trim(), v.minLength(1, 'a list needs a name'), v.maxLength(100))

const membership = (listId: string, userId: string) => `${listId}:${userId}`

/**
 * Refuses a list the user isn't a member of; someone else's list looks the same as a missing one. Only the
 * server knows the memberships, so in the browser the change shows and the server's answer decides.
 */
async function memberOf(tx: MutatorTx, side: 'client' | 'server', listId: string, userId: string | undefined) {
  if (!userId) throw new MutatorError('forbidden', 'no user')
  if (side === 'server' && !(await tx.get(members, membership(listId, userId)))) throw new MutatorError('not_found', 'no such list')
}

/** The todo, if it is in one of the user's lists. */
async function todoOf(tx: MutatorTx, side: 'client' | 'server', id: string, userId: string | undefined) {
  const todo = await tx.get(todos, id)
  if (!todo) throw new MutatorError('not_found', 'no such todo')
  await memberOf(tx, side, todo.listId, userId)
  return todo
}

export const createList = defineMutator({
  name: 'lists.create',
  input: v.object({ id, name }),
  async run({ tx, input, userId }) {
    if (!userId) throw new MutatorError('forbidden', 'no user')
    await tx.insert(lists, { id: input.id, name: input.name })
    await tx.insert(members, { id: membership(input.id, userId), listId: input.id, userId })
  },
})

/** Anyone with a list's id (from a share link) may join it. */
export const joinList = defineMutator({
  name: 'lists.join',
  input: v.object({ listId: id }),
  async run({ tx, input, userId, side }) {
    if (!userId) throw new MutatorError('forbidden', 'no user')
    // The browser doesn't have the list yet; it arrives once the server has added the membership.
    if (side === 'client') return
    if (!(await tx.get(lists, input.listId))) throw new MutatorError('not_found', 'no such list')
    if (!(await tx.get(members, membership(input.listId, userId)))) await tx.insert(members, { id: membership(input.listId, userId), listId: input.listId, userId })
  },
})

export const leaveList = defineMutator({
  name: 'lists.leave',
  input: v.object({ listId: id }),
  async run({ tx, input, userId, side }) {
    await memberOf(tx, side, input.listId, userId)
    if (side === 'server') await tx.delete(members, membership(input.listId, userId!))
  },
})

export const addTodo = defineMutator({
  name: 'todos.add',
  // The browser picks the id, so the new row has its final key at once.
  input: v.object({ id, listId: id, title }),
  async run({ tx, input, userId, side }) {
    await memberOf(tx, side, input.listId, userId)
    await tx.insert(todos, input)
  },
})

export const toggleTodo = defineMutator({
  name: 'todos.toggle',
  input: v.object({ id }),
  async run({ tx, input, userId, side }) {
    const todo = await todoOf(tx, side, input.id, userId)
    await tx.update(todos, todo.id, { done: !todo.done })
  },
})

export const renameTodo = defineMutator({
  name: 'todos.rename',
  input: v.object({ id, title }),
  async run({ tx, input, userId, side }) {
    await todoOf(tx, side, input.id, userId)
    await tx.update(todos, input.id, { title: input.title })
  },
})

export const removeTodo = defineMutator({
  name: 'todos.remove',
  input: v.object({ id }),
  async run({ tx, input, userId, side }) {
    await todoOf(tx, side, input.id, userId)
    await tx.delete(todos, input.id)
  },
})

export const mutators = [createList, joinList, leaveList, addTodo, toggleTodo, renameTodo, removeTodo]

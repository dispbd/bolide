import { z } from 'zod'
import { defineMutator, mutatorRegistry, MutatorError, type Row } from '../core/mutator.ts'

export interface Todo extends Row {
  id: string
  title: string
  done: boolean
  owner_id: string
}

export const createTodo = defineMutator({
  name: 'todos.create',
  input: z.object({ id: z.uuid(), title: z.string().min(1).max(200), owner_id: z.uuid() }),
  async run({ tx, input, userId }) {
    // The server decides who owns the row, whatever the client sent.
    const owner_id = tx.side === 'server' ? userId! : input.owner_id
    await tx.insert('todos', { id: input.id, title: input.title, done: false, owner_id })
  },
})

export const toggleTodo = defineMutator({
  name: 'todos.toggle',
  input: z.object({ id: z.uuid() }),
  async run({ tx, input }) {
    const todo = await tx.get<Todo>('todos', input.id)
    if (!todo) throw new MutatorError('todo not found', 'not_found')
    await tx.update('todos', input.id, { done: !todo.done })
  },
})

export const renameTodo = defineMutator({
  name: 'todos.rename',
  input: z.object({ id: z.uuid(), title: z.string().min(1).max(200) }),
  async run({ tx, input, userId }) {
    const todo = await tx.get<Todo>('todos', input.id)
    if (!todo) throw new MutatorError('todo not found', 'not_found')
    // Server-only rule: the client cannot check ownership, so it renames
    // optimistically and the server may reject it, which rolls the UI back.
    if (tx.side === 'server' && todo.owner_id !== userId) {
      throw new MutatorError('only the owner can rename a todo', 'forbidden')
    }
    await tx.update('todos', input.id, { title: input.title })
  },
})

export const mutators = mutatorRegistry(createTodo, toggleTodo, renameTodo)

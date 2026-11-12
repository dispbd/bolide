// Compile-time checks for @bolide/data, run by `npm run typecheck`.
import { z } from 'zod'
import { defineService } from '@bolide/core'
import { defineMutator, defineShape, defineTable, t, type Insert, type Patch, type Row, type ShapeRow, type Where } from '../src/index.ts'
import { onServer } from '../src/server/index.ts'

const todos = defineTable('todos', {
  id: t.uuid().primaryKey().defaultRandom(),
  title: t.text(),
  done: t.boolean().default(false),
  note: t.text().nullable(),
  priority: t.integer(),
})

export const row: Row<typeof todos> = { id: '', title: '', done: false, note: null, priority: 1 }
// @ts-expect-error note is string or null, never missing in a row
export const noNote: Row<typeof todos> = { id: '', title: '', done: false, priority: 1 }

export const insert: Insert<typeof todos> = { title: 'x', priority: 1 } // id, done and note are optional
// @ts-expect-error title is required on insert
export const noTitle: Insert<typeof todos> = { priority: 1 }

export const patch: Patch<typeof todos> = { done: true }
// @ts-expect-error the primary key can't be patched
export const patchId: Patch<typeof todos> = { id: 'x' }

export const where: Where<typeof todos> = { priority: { gte: 2 }, note: null, title: { in: ['a'] } }
// @ts-expect-error priority is a number
export const badWhere: Where<typeof todos> = { priority: 'high' }
// @ts-expect-error no such column
export const noColumn: Where<typeof todos> = { owner: 'x' }

const titles = defineShape('todos.titles', todos, { columns: ['title'] })
export const shaped: ShapeRow<typeof titles> = { id: '', title: '' }
// @ts-expect-error done isn't in the shape
export const shapedDone: ShapeRow<typeof titles> = { id: '', title: '', done: true }
// @ts-expect-error no such column
defineShape('todos.bad', todos, { columns: ['nope'] })

const rename = defineMutator({ name: 'todos.rename', input: z.object({ id: z.string(), title: z.string() }), run: () => {} })
const Mailer = defineService({ name: 'Mailer', factory: () => ({ send: (to: string) => to }) })
onServer(rename, {
  inject: { mail: Mailer },
  run: ({ input }, { mail }) => {
    mail.send(input.title)
    // @ts-expect-error input has no body
    input.body
    // @ts-expect-error send takes a string
    mail.send(1)
  },
})

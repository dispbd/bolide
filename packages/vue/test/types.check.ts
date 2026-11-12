// Compile-time checks, run by `npm run typecheck`.
import { z } from 'zod'
import { defineMutator, defineShape, defineTable, t } from '@bolide/data'
import { useMutation, useRow, useShape } from '../src/index.ts'

const notes = defineTable('notes', { id: t.uuid().primaryKey(), body: t.text(), secret: t.text() })
const pub = defineShape('notes.public', notes, { columns: ['body'] })
const add = defineMutator({ name: 'notes.add', input: z.object({ body: z.string() }), run: () => {} })

export function check() {
  const { rows } = useShape(pub)
  const body: string = rows.value[0]!.body
  // @ts-expect-error the shape leaves out secret
  rows.value[0]!.secret
  // @ts-expect-error rows are read-only
  rows.value = []
  const id: string | undefined = useRow(pub, () => 'x').value?.id
  const m = useMutation(add)
  m.mutate({ body: 'x' })
  // @ts-expect-error body is a string
  m.mutate({ body: 1 })
  return [body, id]
}

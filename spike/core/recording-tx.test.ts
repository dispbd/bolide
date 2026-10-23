import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordingTx } from './recording-tx.ts'
import { validate, type MutatorTx, type Row } from './mutator.ts'
import { createTodo, renameTodo, toggleTodo } from '../app/mutators.ts'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const T1 = '00000000-0000-4000-8000-000000000001'

const store = new Map<string, Row>([[T1, { id: T1, title: 'milk', done: false, owner_id: A }]])
const read = (_table: string, id: string) => store.get(id)

test('toggle records one update based on the local row', async () => {
  const { tx, ops } = createRecordingTx(read)
  await toggleTodo.run({ tx, input: { id: T1 } })
  assert.deepEqual(ops, [{ type: 'update', table: 'todos', id: T1, patch: { done: true } }])
  assert.equal(store.get(T1)!.done, false, 'the store itself is not touched')
})

test('reads see the mutator\'s own earlier writes', async () => {
  const { tx, ops } = createRecordingTx(read)
  await toggleTodo.run({ tx, input: { id: T1 } })
  await toggleTodo.run({ tx, input: { id: T1 } })
  assert.deepEqual(ops.map((o) => o.type === 'update' && o.patch.done), [true, false])
})

test('rename is optimistic on the client even for a non-owner', async () => {
  const { tx, ops } = createRecordingTx(read)
  await renameTodo.run({ tx, input: { id: T1, title: 'oat milk' } })
  assert.equal(ops.length, 1)
})

test('rename is rejected on the server for a non-owner', async () => {
  const serverTx: MutatorTx = {
    side: 'server',
    get: async (_t, id) => store.get(id) as any,
    insert: async () => {},
    update: async () => {},
    delete: async () => {},
  }
  await assert.rejects(
    async () => renameTodo.run({ tx: serverTx, input: { id: T1, title: 'x' }, userId: B }),
    /only the owner/,
  )
})

test('server overrides owner_id on create', async () => {
  const inserted: Row[] = []
  const serverTx: MutatorTx = {
    side: 'server',
    get: async () => undefined,
    insert: async (_t, row) => void inserted.push(row),
    update: async () => {},
    delete: async () => {},
  }
  await createTodo.run({ tx: serverTx, input: { id: T1, title: 'x', owner_id: B }, userId: A })
  assert.equal(inserted[0].owner_id, A)
})

test('input is validated through Standard Schema', async () => {
  await assert.rejects(validate(toggleTodo.input, { id: 'nope' }), (e: any) => e.code === 'invalid_input')
})

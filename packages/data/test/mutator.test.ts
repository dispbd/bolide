import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { checkInput, defineMutator, MutatorError, type MutatorInput } from '../src/index.ts'

const rename = defineMutator({ name: 'todos.rename', input: z.object({ id: z.uuid(), title: z.string().trim().min(1) }), run: () => {} })

describe('mutators', () => {
  test('input is checked and transformed by its schema', async () => {
    const id = crypto.randomUUID()
    assert.deepEqual(await checkInput(rename, { id, title: '  x ' }), { id, title: 'x' })
    await assert.rejects(checkInput(rename, { id: 'no', title: '' }), (e) => e instanceof MutatorError && e.code === 'invalid_input' && /^todos.rename: id: .*; title: /.test(e.message))
    assert.equal(rename.local, true)
    assert.equal(defineMutator({ name: 'billing.charge', input: z.object({}), local: false, run: () => {} }).local, false)
  })

  test('mistakes fail at definition', () => {
    assert.throws(() => defineMutator({ name: 'todos rename', input: z.object({}), run: () => {} }), /dotted words/)
    assert.throws(() => defineMutator({ name: 'x', input: {} as never, run: () => {} }), /needs an input schema/)
  })
})

// Compile-time: mutate() takes the schema's input type.
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const inputCheck: Eq<MutatorInput<typeof rename>, { id: string; title: string }> = true
void inputCheck

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePgOutput, formatLsn, parseLsn, type Relation } from '../src/server/pgoutput.ts'

/** Builds pgoutput messages byte by byte, as Postgres sends them. */
function bytes(...parts: (string | ['i8' | 'i16' | 'i32' | 'u64', number | bigint] | Uint8Array)[]) {
  const chunks: number[] = []
  for (const p of parts) {
    if (typeof p === 'string') chunks.push(...new TextEncoder().encode(p))
    else if (p instanceof Uint8Array) chunks.push(...p)
    else {
      const [kind, v] = p
      const size = { i8: 1, i16: 2, i32: 4, u64: 8 }[kind]
      const b = new DataView(new ArrayBuffer(size))
      if (kind === 'i8') b.setInt8(0, Number(v))
      if (kind === 'i16') b.setInt16(0, Number(v))
      if (kind === 'i32') b.setInt32(0, Number(v))
      if (kind === 'u64') b.setBigUint64(0, BigInt(v))
      chunks.push(...new Uint8Array(b.buffer))
    }
  }
  return new Uint8Array(chunks)
}
const cstr = (s: string) => `${s}\0`
const textCol = (v: string) => bytes('t', ['i32', new TextEncoder().encode(v).length], v)

const items: Relation = { id: 16400, schema: 'app', name: 'items', columns: [{ name: 'id', type: 23 }, { name: 'title', type: 25 }, { name: 'body', type: 25 }] }
const cols = (id: number) => (id === items.id ? items.columns : undefined)

describe('pgoutput', () => {
  test('decodes a transaction: begin, relation, insert, update, delete, truncate, commit', () => {
    assert.deepEqual(decodePgOutput(bytes('B', ['u64', 0x16b3748n], ['u64', 0n], ['i32', -5]), cols), { tag: 'begin', lsn: 0x16b3748n, xid: 4294967291 })

    const relation = bytes('R', ['i32', items.id], cstr('app'), cstr('items'), ['i8', 102], ['i16', 3], ...items.columns.flatMap((c) => [bytes(['i8', 1]), bytes(cstr(c.name)), bytes(['i32', c.type]), bytes(['i32', -1])]))
    assert.deepEqual(decodePgOutput(relation, cols), { tag: 'relation', relation: items })

    const insert = bytes('I', ['i32', items.id], 'N', ['i16', 3], textCol('1'), textCol('héllo'), 'n')
    assert.deepEqual(decodePgOutput(insert, cols), { tag: 'insert', relation: items.id, new: { id: '1', title: 'héllo', body: null } })

    // An unchanged TOAST value ('u') comes from the old row.
    const update = bytes('U', ['i32', items.id], 'O', ['i16', 3], textCol('1'), textCol('old'), textCol('long text'), 'N', ['i16', 3], textCol('1'), textCol('new'), 'u')
    assert.deepEqual(decodePgOutput(update, cols), {
      tag: 'update',
      relation: items.id,
      old: { id: '1', title: 'old', body: 'long text' },
      new: { id: '1', title: 'new', body: 'long text' },
    })

    const del = bytes('D', ['i32', items.id], 'O', ['i16', 3], textCol('1'), textCol('new'), 'n')
    assert.deepEqual(decodePgOutput(del, cols), { tag: 'delete', relation: items.id, old: { id: '1', title: 'new', body: null } })

    assert.deepEqual(decodePgOutput(bytes('T', ['i32', 2], ['i8', 0], ['i32', 16400], ['i32', 16401]), cols), { tag: 'truncate', relations: [16400, 16401] })
    assert.deepEqual(decodePgOutput(bytes('C', ['i8', 0], ['u64', 0x16b3748n], ['u64', 0x16b3790n], ['u64', 0n]), cols), { tag: 'commit', lsn: 0x16b3748n, end: 0x16b3790n })
    assert.deepEqual(decodePgOutput(bytes('Y', ['i32', 1]), cols), { tag: 'other' })
  })

  test('a row before its relation is a clear error', () => {
    assert.throws(() => decodePgOutput(bytes('I', ['i32', 1], 'N', ['i16', 0]), cols), /before its description/)
  })

  test('LSNs read and print like Postgres', () => {
    assert.equal(parseLsn('0/16B3748'), 0x16b3748n)
    assert.equal(parseLsn('1/0'), 1n << 32n)
    assert.equal(formatLsn(parseLsn('A/16B3748')), 'A/16B3748')
  })
})

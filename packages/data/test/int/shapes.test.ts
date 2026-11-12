import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { defineTable, t } from '../../src/index.ts'
import { schemaSql, whereSql } from '../../src/server/index.ts'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide'
const schema = `bolide_shapes_${process.pid}`
const admin = postgres(url, { onnotice: () => {} })
const sql = postgres(url, { onnotice: () => {}, connection: { search_path: schema } })

const items = defineTable('items', {
  id: t.integer().primaryKey(),
  ownerId: t.uuid(),
  done: t.boolean(),
  rank: t.integer().nullable(),
  price: t.numeric(),
  meta: t.json<{ tag: string }>(),
  dueAt: t.timestamp(),
})

describe('where SQL on Postgres', () => {
  after(async () => {
    await sql.end()
    await admin.unsafe(`drop schema if exists ${schema} cascade`)
    await admin.end()
  })

  test('text parameters compare with each column type as intended', async () => {
    await admin.unsafe(`create schema ${schema}`)
    await sql.unsafe(schemaSql([items]))
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    await sql.unsafe(`insert into items values
      (1, '${a}', true, 1, '10.50', '{"tag":"x"}', '2026-01-01T00:00:00Z'),
      (2, '${a}', false, null, '3', '{"tag":"y"}', '2026-06-01T00:00:00Z'),
      (3, '${b}', false, 5, '7.25', '{"tag":"x"}', '2026-12-01T00:00:00Z')`)
    // Electric sends params as text, as here; Postgres reads them by the column's type.
    const ids = async (where: Parameters<typeof whereSql>[1]) => {
      const w = whereSql(items, where)
      const rows = await sql.unsafe(`select id from items${w.sql ? ` where ${w.sql}` : ''} order by id`, w.params)
      return rows.map((r) => r.id)
    }
    assert.deepEqual(await ids({}), [1, 2, 3])
    assert.deepEqual(await ids({ ownerId: a, done: false }), [2])
    assert.deepEqual(await ids({ rank: null }), [2])
    assert.deepEqual(await ids({ rank: { ne: null } }), [1, 3])
    assert.deepEqual(await ids({ rank: { gte: 2 } }), [3])
    assert.deepEqual(await ids({ price: { gt: '7' } }), [1, 3], 'numeric compares as a number, not as text')
    assert.deepEqual(await ids({ dueAt: { lt: '2026-07-01T00:00:00Z' } }), [1, 2])
    assert.deepEqual(await ids({ id: { in: [1, 3] } }), [1, 3])
    assert.deepEqual(await ids({ id: { in: [] } }), [])
  })
})

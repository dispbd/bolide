import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { defineTable, fromSqlRow, t, toSqlRow, withDefaults } from '../../src/index.ts'
import { migrate, schemaSql } from '../../src/server/index.ts'

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide', { onnotice: () => {} })
const schema = `bolide_data_${process.pid}`

const users = defineTable('users', { id: t.uuid().primaryKey().defaultRandom(), email: t.text().unique(), role: t.enum(['admin', 'member']).default('member') })
const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid().references(() => users),
  meta: t.json<{ tags: string[] }>().default({ tags: [] }),
  price: t.numeric().nullable(),
  createdAt: t.timestamp().defaultNow(),
})

describe('schema on Postgres', () => {
  // Inside the suite: on Node 20.6 a top-level after() never runs, and the open client keeps the process alive.
  after(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`)
    await sql.end()
  })
  test('generated SQL runs through migrate, and rows round-trip', async () => {
    await sql.unsafe(`create schema ${schema}`)
    const run = (tx: postgres.Sql) => tx.unsafe(`set local search_path to ${schema}`)
    const client = {
      unsafe: (q: string, p?: unknown[]) => sql.unsafe(q, p as never[]),
      begin: <T>(fn: (tx: never) => Promise<T>) =>
        sql.begin(async (tx) => {
          await run(tx as unknown as postgres.Sql)
          return fn({ unsafe: (q: string, p?: unknown[]) => tx.unsafe(q, p as never[]), begin: () => Promise.reject(new Error('nested')) } as never)
        }) as Promise<T>,
    }
    const migrations = [{ name: '0001_init', sql: schemaSql([todos, users]) }]
    assert.deepEqual(await migrate(client, migrations), { applied: ['0001_init'], skipped: [] })
    assert.deepEqual(await migrate(client, migrations), { applied: [], skipped: ['0001_init'] })

    const user = withDefaults(users, { email: 'ann@x.io' })
    const todo = withDefaults(todos, { id: crypto.randomUUID(), title: 'Buy milk', ownerId: user.id, price: '12.50' })
    await sql.begin(async (tx) => {
      await run(tx as unknown as postgres.Sql)
      for (const [table, row] of [[users, user], [todos, todo]] as const) {
        const r = toSqlRow(table, row)
        const cols = Object.keys(r)
        await tx.unsafe(`insert into ${table.name} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((c, i) => (c === 'meta' ? `$${i + 1}::text::jsonb` : `$${i + 1}`)).join(', ')})`, Object.values(r).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)) as never[])
      }
    })
    const [read] = await sql.unsafe(`select id, title, done, owner_id, meta, price::text, to_json(created_at)#>>'{}' as created_at from ${schema}.todos`)
    const back = fromSqlRow(todos, read!)
    assert.deepEqual({ ...back, createdAt: Date.parse(back.createdAt) }, { ...todo, createdAt: Date.parse(todo.createdAt) })
    await assert.rejects(sql.unsafe(`insert into ${schema}.users (email, role) values ('b@x.io', 'owner')`), /check constraint/)
    const [raw] = await sql.unsafe(`insert into ${schema}.users (email) values ('c@x.io') returning id, role`)
    assert.equal(raw!.role, 'member', 'SQL defaults cover raw inserts')
    assert.match(String(raw!.id), /^[0-9a-f-]{36}$/)
  })
})

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPatch, defineTable, fromSqlRow, snake, t, toSqlRow, withDefaults, type Insert, type Patch, type Row } from '../src/index.ts'
import { migrate, readMigrations, schemaSql, type SqlClient } from '../src/server/index.ts'

const users = defineTable('users', {
  id: t.uuid().primaryKey().defaultRandom(),
  email: t.text().unique(),
  role: t.enum(['admin', 'member']).default('member'),
})

const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid().references(() => users),
  note: t.text().nullable(),
  meta: t.json<{ tags: string[] }>().default({ tags: [] }),
  price: t.numeric().nullable(),
  createdAt: t.timestamp().defaultNow(),
})

const validate = (value: unknown) => todos['~standard'].validate(value) as { value?: Row<typeof todos>; issues?: { message: string }[] }

describe('tables', () => {
  test('inserts are checked and completed with defaults', () => {
    const id = crypto.randomUUID()
    const ownerId = crypto.randomUUID()
    const { value } = validate({ id, title: 'Buy milk', ownerId })
    assert.deepEqual({ ...value, createdAt: undefined }, { id, title: 'Buy milk', done: false, ownerId, note: null, meta: { tags: [] }, price: null, createdAt: undefined })
    assert.ok(Date.parse(value!.createdAt) <= Date.now())
    assert.notEqual(withDefaults(todos, { id, title: 'x', ownerId }).meta, withDefaults(todos, { id, title: 'x', ownerId }).meta, 'defaults are copied, not shared')
    assert.match(withDefaults(users, { email: 'a@x.io' }).id, /^[0-9a-f-]{36}$/)
  })

  test('bad values are reported per column', () => {
    const messages = (v: unknown) => validate(v).issues?.map((i) => i.message) ?? []
    assert.deepEqual(messages({ id: 'nope', title: 1, done: 'yes', extra: 1, note: null }), [
      'unknown column "extra" in todos',
      'todos.id: expected a uuid',
      'todos.title: expected a string',
      'todos.done: expected true or false',
      'todos.ownerId is required',
    ])
    assert.deepEqual(messages({ id: crypto.randomUUID(), title: 'x', ownerId: crypto.randomUUID(), done: null, price: '1.2.3', createdAt: '2026-11-12' }), [
      "todos.done can't be null",
      'todos.price: expected a decimal string such as "12.50"',
      'todos.createdAt: expected an ISO 8601 timestamp with a zone',
    ])
    assert.deepEqual(messages('row'), ['a todos row must be an object'])
    assert.deepEqual(
      checkPatch(todos, { id: crypto.randomUUID(), title: 'y' }).map((i) => i.message),
      ["todos.id is the primary key and can't be updated"],
    )
    assert.deepEqual(checkPatch(users, { role: 'owner' }).map((i) => i.message), ['users.role: expected one of "admin", "member"'])
  })

  test('keys are camelCase in code and snake_case in SQL', () => {
    assert.deepEqual(['ownerId', 'createdAt', 'userIDCard', 'a1B'].map(snake), ['owner_id', 'created_at', 'user_id_card', 'a1_b'])
    assert.deepEqual(toSqlRow(todos, { ownerId: 'u', createdAt: 'c' }), { owner_id: 'u', created_at: 'c' })
    assert.deepEqual(fromSqlRow(todos, { owner_id: 'u', title: 'x', other: 1 }), { ownerId: 'u', title: 'x' })
    const named = defineTable('things', { id: t.integer().primaryKey(), legacy: t.text().named('OldName'.toLowerCase()) })
    assert.equal(named.columns.legacy.sqlName, 'oldname')
  })

  test('mistakes fail at definition', () => {
    assert.throws(() => defineTable('Todos', { id: t.uuid().primaryKey() }), /lowercase SQL identifier/)
    assert.throws(() => defineTable('a', { title: t.text() }), /exactly one primary key.*found none/)
    assert.throws(() => defineTable('a', { a: t.uuid().primaryKey(), b: t.uuid().primaryKey() }), /found a, b/)
    assert.throws(() => defineTable('a', { id: t.uuid().primaryKey().nullable() }), /can't be nullable/)
    assert.throws(() => defineTable('a', { id: t.uuid().primaryKey(), fooBar: t.text(), foo_bar: t.text() }), /two columns map to "foo_bar"/)
    assert.throws(() => t.text().defaultNow(), /defaultNow\(\) is for timestamp columns/)
    assert.throws(() => t.integer().default(1.5), /32-bit integer/)
  })
})

describe('SQL', () => {
  test('schemaSql orders tables by their references', () => {
    const sql = schemaSql([todos, users])
    assert.ok(sql.indexOf('create table "users"') < sql.indexOf('create table "todos"'))
    assert.match(sql, /"id" uuid primary key default gen_random_uuid\(\)/)
    assert.match(sql, /"role" text not null default 'member' check \("role" in \('admin', 'member'\)\)/)
    assert.match(sql, /"owner_id" uuid not null references "users" \("id"\)/)
    assert.match(sql, /"note" text,/)
    assert.match(sql, /"meta" jsonb not null default '\{"tags":\[\]\}'::jsonb/)
    assert.match(sql, /"created_at" timestamptz not null default now\(\)/)
    assert.throws(() => schemaSql([todos]), /references "users", which is not in the list/)
  })

  test('migrate applies pending files once, in order, and refuses edited ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bolide-migrations-'))
    try {
      await writeFile(join(dir, '0002_more.sql'), 'alter table todos add column x int;')
      await writeFile(join(dir, '0001_init.sql'), 'create table todos (id int);')
      const migrations = await readMigrations(dir)
      assert.deepEqual(migrations.map((m) => m.name), ['0001_init', '0002_more'])
      const db = fakeDb()
      assert.deepEqual(await migrate(db, migrations), { applied: ['0001_init', '0002_more'], skipped: [] })
      assert.deepEqual(await migrate(db, migrations), { applied: [], skipped: ['0001_init', '0002_more'] })
      assert.deepEqual(db.ran, ['create table todos (id int);', 'alter table todos add column x int;'])
      await assert.rejects(migrate(db, [{ name: '0001_init', sql: 'create table todos (id bigint);' }]), /0001_init changed after it was applied/)
      await writeFile(join(dir, 'notes.txt'), '')
      await assert.rejects(readMigrations(dir), /notes.txt is not named like/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** Just enough of Postgres for the runner: the bookkeeping table and a log of user statements. */
function fakeDb() {
  const applied = new Map<string, string>()
  const ran: string[] = []
  const db: SqlClient & { ran: string[] } = {
    ran,
    async unsafe(query, params = []) {
      if (/pg_advisory_xact_lock|create table if not exists bolide_migrations/.test(query)) return []
      if (query.startsWith('select name, checksum')) return [...applied].map(([name, checksum]) => ({ name, checksum }))
      if (query.startsWith('insert into bolide_migrations')) {
        applied.set(String(params[0]), String(params[1]))
        return []
      }
      ran.push(query)
      return []
    },
    begin: (fn) => fn(db),
  }
  return db
}

// Compile-time: inferred row, insert and patch types.
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Todo = Row<typeof todos>
const typeChecks: [
  Eq<Todo['note'], string | null>,
  Eq<Todo['role' & keyof Todo], never>,
  Eq<Row<typeof users>['role'], 'admin' | 'member'>,
  Eq<Todo['meta'], { tags: string[] }>,
  Eq<keyof Insert<typeof todos>, keyof Todo>,
  Eq<Pick<Insert<typeof todos>, 'id' | 'title' | 'ownerId'>, { id: string; title: string; ownerId: string }>,
  Eq<'id' extends keyof Patch<typeof todos> ? true : false, false>,
  Eq<(typeof todos)['primaryKey'], 'id'>,
] = [true, true, true, true, true, true, true, true]
void typeChecks
// @ts-expect-error title is required
const missing: Insert<typeof todos> = { id: '', ownerId: '' }
void missing
// @ts-expect-error done is a boolean
const wrong: Patch<typeof todos> = { done: 'yes' }
void wrong

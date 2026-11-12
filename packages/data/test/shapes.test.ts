import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, createLogger, defineModule, defineService } from '@bolide/core'
import { defineShape, defineTable, t, type ShapeRow } from '../src/index.ts'
import { dataModule, electric, whereSql, type SqlClient } from '../src/server/index.ts'

const users = defineTable('users', { id: t.uuid().primaryKey(), email: t.text(), passwordHash: t.text() })
const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean(),
  ownerId: t.uuid(),
  priority: t.integer().nullable(),
  meta: t.json<{ tags: string[] }>(),
})
const mine = defineShape('todos.mine', todos, { where: ({ userId }) => (userId ? { ownerId: userId } : false) })
const people = defineShape('users.public', users, { columns: ['email'] })

describe('shapes', () => {
  test('defineShape fixes the columns and checks them', () => {
    assert.deepEqual(people.columns, ['id', 'email'], 'the primary key is always sent')
    assert.equal(mine.columns.length, 6)
    assert.throws(() => defineShape('x', users, { columns: ['nope' as never] }), /users has no column "nope"/)
    assert.throws(() => defineShape('no spaces', users), /dotted words/)
  })

  test('whereSql uses table columns and parameters only', () => {
    assert.deepEqual(whereSql(todos, {}), { sql: '', params: [] })
    assert.deepEqual(whereSql(todos, { ownerId: 'u1', done: false, priority: null }), { sql: '"owner_id" = $1 and "done" = $2 and "priority" is null', params: ['u1', 'false'] })
    assert.deepEqual(whereSql(todos, { priority: { gte: 2 }, title: { in: ['a', "b'); drop"] } }), { sql: '"priority" >= $1 and "title" in ($2, $3)', params: ['2', 'a', "b'); drop"] })
    assert.deepEqual(whereSql(todos, { priority: { ne: null }, ownerId: { in: [] } }), { sql: '"priority" is not null and false', params: [] })
    assert.throws(() => whereSql(todos, { meta: { tags: ['x'] } } as never), /json columns can't be filtered on/)
    assert.throws(() => whereSql(todos, { nope: 1 } as never), /no column "nope"/)
    assert.throws(() => whereSql(todos, { priority: { gt: 1, lt: 5 } as never }), /one of in, ne/)
    assert.throws(() => whereSql(todos, { priority: { like: 1 } as never }), /unknown operator "like"/)
  })

  test('electric() asks for the shape the server decided, with the browser\'s protocol params only', async () => {
    let asked: URL | undefined
    const source = electric({
      url: 'http://electric:3000',
      secret: 's3',
      fetch: async (u) => {
        asked = new URL(String(u))
        return new Response('[]', { headers: { 'cache-control': 'public, max-age=60', 'content-length': '2', 'electric-handle': 'h1' } })
      },
    })
    const protocol = new URLSearchParams('offset=-1&live=true&table=users&where=true&columns=password_hash')
    const res = await source.fetchShape({ table: 'todos', columns: ['id', 'owner_id'], where: whereSql(todos, { ownerId: 'u1' }), protocol, signal: AbortSignal.timeout(1000) })
    assert.deepEqual(Object.fromEntries(asked!.searchParams), { offset: '-1', live: 'true', table: 'todos', columns: '"id","owner_id"', where: '"owner_id" = $1', 'params[1]': 'u1', secret: 's3' })
    assert.equal(res.headers.get('cache-control'), 'private, max-age=60')
    assert.equal(res.headers.get('electric-handle'), 'h1')
    assert.equal(res.headers.get('content-length'), null)
  })

  test('the shape route applies the read rule for the current user', async () => {
    const seen: { table: string; columns: string[]; where: { sql: string; params: string[] } }[] = []
    const sync = { fetchShape: async (r: (typeof seen)[number]) => (seen.push({ table: r.table, columns: r.columns, where: r.where }), Response.json([])) }
    let current: string | undefined
    const CurrentUser = defineService({ name: 'CurrentUser', scope: 'request', factory: () => current })
    const sql: SqlClient = { unsafe: async () => [], begin: (fn) => fn(sql) }
    const app = await createApp({
      modules: [
        defineModule({ name: 'auth', global: true, providers: [CurrentUser], exports: [CurrentUser] }),
        dataModule({ sql, tables: [todos, users], mutators: [], shapes: [mine, people], sync: sync as never, userId: CurrentUser }),
      ],
      logger: createLogger({ write: () => {} }),
    })
    const get = (path: string) => app.fetch(new Request(`http://x/api/data/shape/${path}`))
    assert.equal((await get('todos.mine?offset=-1')).status, 401)
    current = 'u1'
    assert.equal((await get('todos.mine?offset=-1')).status, 200)
    assert.equal((await get('users.public?offset=-1')).status, 200)
    assert.equal((await get('users.all')).status, 404)
    assert.deepEqual(seen, [
      { table: 'todos', columns: ['id', 'title', 'done', 'owner_id', 'priority', 'meta'], where: { sql: '"owner_id" = $1', params: ['u1'] } },
      { table: 'users', columns: ['id', 'email'], where: { sql: '', params: [] } },
    ])
    await app.close()
  })

  test('mistakes fail at boot', () => {
    const sql: SqlClient = { unsafe: async () => [], begin: (fn) => fn(sql) }
    const sync = electric({ url: 'http://e' })
    assert.throws(() => dataModule({ sql, tables: [todos], mutators: [], shapes: [mine] }), /shapes need a sync source/)
    assert.throws(() => dataModule({ sql, tables: [todos], mutators: [], shapes: [people], sync }), /reads table "users", which is not in/)
    assert.throws(() => dataModule({ sql, tables: [todos], mutators: [], shapes: [mine, mine], sync }), /two shapes are named "todos.mine"/)
  })
})

// Compile-time: the browser's row type holds only the shape's columns.
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const rowCheck: Eq<ShapeRow<typeof people>, { id: string; email: string }> = true
void rowCheck
// @ts-expect-error ownerId is a string, not a number
defineShape('x', todos, { where: () => ({ ownerId: 1 }) })
// @ts-expect-error no such column
defineShape('y', todos, { where: () => ({ owner: 'u' }) })

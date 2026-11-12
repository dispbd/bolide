import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { z } from 'zod'
import { createApp, createLogger, defineModule, defineService, type App } from '@bolide/core'
import { defineMutator, defineTable, MutatorError, t } from '../../src/index.ts'
import { dataModule, onServer, schemaSql } from '../../src/server/index.ts'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide'
const schema = `bolide_mutate_${process.pid}`
const admin = postgres(url, { onnotice: () => {} })
const sql = postgres(url, { onnotice: () => {}, connection: { search_path: schema } })

const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid(),
  meta: t.json<{ tags: string[] }>().default({ tags: [] }),
  dueAt: t.timestamp().nullable(),
})

const create = defineMutator({
  name: 'todos.create',
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  async run({ tx, input, userId }) {
    if (!userId) throw new MutatorError('forbidden', 'sign in first')
    await tx.insert(todos, { id: input.id, title: input.title, ownerId: userId, meta: { tags: ['new'] }, dueAt: '2026-11-12T10:00:00+03:00' })
  },
})
const toggle = defineMutator({
  name: 'todos.toggle',
  input: z.object({ id: z.uuid() }),
  async run({ tx, input, side, userId }) {
    const todo = await tx.get(todos, input.id)
    if (!todo) throw new MutatorError('not_found', 'no such todo')
    if (side === 'server' && todo.ownerId !== userId) throw new MutatorError('forbidden', 'not your todo')
    await tx.update(todos, input.id, { done: !todo.done })
  },
})
const broken = defineMutator({
  name: 'todos.broken',
  input: z.object({ id: z.uuid() }),
  async run({ tx, input }) {
    await tx.insert(todos, { id: input.id, title: 'half', ownerId: input.id })
    await tx.update(todos, input.id, { title: 42 as never })
  },
})
const Audit = defineService({ name: 'Audit', factory: () => [] as string[] })
const rename = defineMutator({ name: 'todos.rename', input: z.object({ id: z.uuid(), title: z.string() }), run: () => {} })
const renameOnServer = onServer(rename, {
  inject: { audit: Audit },
  async run({ tx, input }, { audit }) {
    await tx.update(todos, input.id, { title: input.title.trim() })
    audit.push(`renamed ${input.id}`)
  },
})

const ann = crypto.randomUUID()
const bob = crypto.randomUUID()
const CurrentUser = defineService({ name: 'CurrentUser', scope: 'request', inject: {}, factory: (): string | undefined => current })
let current: string | undefined = ann

describe('mutations on Postgres', () => {
  let app: App
  before(async () => {
    await admin.unsafe(`create schema ${schema}`)
    await sql.unsafe(schemaSql([todos]))
    app = await createApp({
      modules: [
        defineModule({ name: 'app', global: true, providers: [CurrentUser, Audit], exports: [CurrentUser, Audit] }),
        dataModule({ sql, tables: [todos], mutators: [create, toggle, broken, renameOnServer], userId: CurrentUser }),
      ],
      logger: createLogger({ write: () => {} }),
    })
  })
  after(async () => {
    await app?.close()
    await sql.end()
    await admin.unsafe(`drop schema if exists ${schema} cascade`)
    await admin.end()
  })

  const send = async (name: string, input: unknown, id: string = crypto.randomUUID()) => {
    const res = await app.fetch(new Request('http://x/api/data/mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name, input }) }))
    return { status: res.status, body: (await res.json()) as { txid?: string; error?: string; message?: string } }
  }
  const row = async (id: string) => (await sql.unsafe(`select * from todos where id = $1`, [id]))[0]

  test('a mutation runs in a transaction and answers its txid', async () => {
    const id = crypto.randomUUID()
    const res = await send('todos.create', { id, title: 'Buy milk' })
    assert.equal(res.status, 200)
    assert.match(res.body.txid!, /^\d+$/)
    const r = await row(id)
    assert.deepEqual([r!.title, r!.done, r!.owner_id, r!.meta], ['Buy milk', false, ann, { tags: ['new'] }])
    assert.equal((r!.due_at as Date).toISOString(), '2026-11-12T07:00:00.000Z')
    assert.equal((await send('todos.toggle', { id })).status, 200)
    assert.equal((await row(id))!.done, true)
  })

  test('the same mutation id applies once', async () => {
    const id = crypto.randomUUID()
    await send('todos.create', { id, title: 'x' })
    const mid = crypto.randomUUID()
    const [a, b] = await Promise.all([send('todos.toggle', { id }, mid), send('todos.toggle', { id }, mid)])
    assert.deepEqual([a.status, b.status, a.body.txid], [200, 200, b.body.txid])
    assert.equal((await row(id))!.done, true, 'toggled once, not twice')
    assert.equal((await send('todos.create', { id: crypto.randomUUID(), title: 'y' }, mid)).body.error, 'conflict', 'an id belongs to one mutator')
  })

  test('rejections map to statuses and roll everything back', async () => {
    const id = crypto.randomUUID()
    await send('todos.create', { id, title: 'Ann’s' })
    current = bob
    assert.deepEqual(await send('todos.toggle', { id }).then((r) => [r.status, r.body.error]), [403, 'forbidden'])
    current = undefined
    assert.deepEqual(await send('todos.create', { id: crypto.randomUUID(), title: 'x' }).then((r) => [r.status, r.body.message]), [403, 'sign in first'])
    current = ann
    assert.deepEqual(await send('todos.toggle', { id: crypto.randomUUID() }).then((r) => [r.status, r.body.error]), [404, 'not_found'])
    assert.deepEqual(await send('todos.create', { id: 'nope', title: '' }).then((r) => [r.status, r.body.error]), [400, 'invalid_input'])
    assert.equal((await send('todos.nope', {})).body.error, 'unknown_mutator')
    const half = crypto.randomUUID()
    const res = await send('todos.broken', { id: half })
    assert.deepEqual([res.status, res.body.message], [400, 'todos.title: expected a string'])
    assert.equal(await row(half), undefined, 'the insert before the failure was rolled back')
  })

  test('onServer bodies get injected services', async () => {
    const id = crypto.randomUUID()
    await send('todos.create', { id, title: 'x' })
    assert.equal((await send('todos.rename', { id, title: '  Tidy  ' })).status, 200)
    assert.equal((await row(id))!.title, 'Tidy')
    assert.deepEqual(app.get(Audit), [`renamed ${id}`])
  })
})

describe('dataModule checks', () => {
  test('mistakes fail at definition', () => {
    assert.throws(() => dataModule({ sql, tables: [todos], mutators: [toggle, toggle] }), /two mutators are named "todos.toggle"/)
    assert.throws(() => dataModule({ sql, tables: [todos], mutators: [rename, renameOnServer] }), /two mutators are named "todos.rename"/)
    assert.throws(() => dataModule({ sql, tables: [todos, todos], mutators: [] }), /two tables are named "todos"/)
    assert.throws(() => defineMutator({ name: 'bad name', input: z.object({}), run: () => {} }), /dotted words/)
  })
})

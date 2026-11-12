import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import postgres from 'postgres'
import { createServer } from './app.ts'
import { mutators, type Todo } from '../app/mutators.ts'
import { createBolideClient, MutationRejected } from '../core/client.ts'

// Needs `npm run db:up` (Postgres + Electric).
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide', { onnotice: () => {} })
const A = randomUUID()
const B = randomUUID()
let server: ReturnType<typeof serve>
let baseUrl: string
let alice: ReturnType<typeof createBolideClient<typeof mutators>>
let bob: ReturnType<typeof createBolideClient<typeof mutators>>

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

before(async () => {
  await sql`truncate todos`
  const app = createServer({ sql, mutators, tables: ['todos'], electricUrl: process.env.ELECTRIC_URL ?? 'http://localhost:3000' })
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://localhost:${info.port}`
      resolve()
    })
  })
  alice = createBolideClient({ baseUrl, userId: A, tables: ['todos'], mutators })
  bob = createBolideClient({ baseUrl, userId: B, tables: ['todos'], mutators })
  await Promise.all([alice.ready(), bob.ready()])
})

after(async () => {
  await Promise.all([alice.close(), bob.close()])
  server.close()
  await sql.end()
})

const todo = (client: typeof alice, id: string) => client.collections.todos.get(id) as Todo | undefined

test('create: visible locally at once, then synced to the other client', async () => {
  const id = randomUUID()
  const tx = await alice.mutate('todos.create', { id, title: 'milk', owner_id: A })
  assert.equal(todo(alice, id)?.title, 'milk', 'optimistic row is there before the server answers')
  await tx.isPersisted.promise
  await until(() => todo(bob, id)?.title === 'milk')
  const [row] = await sql`select * from todos where id = ${id}`
  assert.equal(row.owner_id, A)
})

test('toggle: optimistic flip, confirmed by the server', async () => {
  const id = randomUUID()
  await (await alice.mutate('todos.create', { id, title: 'bread', owner_id: A })).isPersisted.promise
  const tx = await alice.mutate('todos.toggle', { id })
  assert.equal(todo(alice, id)?.done, true)
  await tx.isPersisted.promise
  assert.equal(todo(alice, id)?.done, true, 'stays done after the optimistic layer is dropped')
  await until(() => todo(bob, id)?.done === true)
})

test('rename by a non-owner: optimistic, then rejected and rolled back', async () => {
  const id = randomUUID()
  await (await alice.mutate('todos.create', { id, title: 'eggs', owner_id: A })).isPersisted.promise
  await until(() => todo(bob, id) !== undefined)

  const tx = await bob.mutate('todos.rename', { id, title: 'hacked' })
  assert.equal(todo(bob, id)?.title, 'hacked', 'bob sees his change at once')
  await assert.rejects(tx.isPersisted.promise, (e) => e instanceof MutationRejected && e.status === 403)
  assert.equal(todo(bob, id)?.title, 'eggs', 'and it rolls back after the server says no')
  const [row] = await sql`select title from todos where id = ${id}`
  assert.equal(row.title, 'eggs')
})

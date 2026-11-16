import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { migrate, readMigrations } from '@bolide/data/server'
import postgres from 'postgres'
import { buildApp } from '../src/app.ts'
import { stopBundler } from '../src/web.ts'

// Needs Postgres: DATABASE_URL=postgres://... npm test. Each run uses its own schema and drops it after.
const url = process.env.DATABASE_URL

describe('server', { skip: !url && 'set DATABASE_URL to run against Postgres' }, () => {
  const schema = `todos_test_${process.pid}`
  const admin = postgres(url!, { onnotice: () => {} })
  const sql = postgres(url!, { onnotice: () => {}, connection: { search_path: schema } })
  let app: Awaited<ReturnType<typeof buildApp>>

  before(async () => {
    await admin.unsafe(`create schema ${schema}`)
    await migrate(sql, await readMigrations(new URL('../migrations', import.meta.url).pathname))
    app = await buildApp({ sql }, { env: { LOG_LEVEL: 'warn' } })
  })
  after(async () => {
    await app?.close()
    await stopBundler()
    await sql.end()
    await admin.unsafe(`drop schema if exists ${schema} cascade`)
    await admin.end()
  })

  test('the page gives a new browser a user, and serves the bundle', async () => {
    const page = await app.fetch(new Request('http://test/'))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('set-cookie') ?? '', /^uid=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax/)
    assert.match(await page.text(), /<meta name="user-id" content="[0-9a-f-]{36}">/)
    const js = await app.fetch(new Request('http://test/app.js'))
    assert.equal(js.status, 200)
    assert.match(await js.text(), /todos\.mine/)
  })

  test('a shared list reaches whoever joins it, and no one else', async () => {
    const as = (uid: string) => ({
      mutate: (name: string, input: unknown) =>
        app.fetch(new Request('http://test/api/data/mutate', { method: 'POST', headers: { cookie: `uid=${uid}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), name, input }) })),
      rows: async (shape: string) => {
        const res = await app.fetch(new Request(`http://test/api/data/shape/${shape}?offset=-1`, { headers: { cookie: `uid=${uid}` } }))
        return ((await res.json()) as { value?: Record<string, unknown> }[]).flatMap((m) => (m.value ? [m.value] : []))
      },
    })
    const [ann, bob, cat] = [as(crypto.randomUUID()), as(crypto.randomUUID()), as(crypto.randomUUID())]
    const listId = crypto.randomUUID()
    const id = crypto.randomUUID()
    assert.equal((await ann.mutate('lists.create', { id: listId, name: 'Trip' })).status, 200)
    assert.equal((await ann.mutate('todos.add', { id, listId, title: 'Tickets' })).status, 200)
    assert.equal((await cat.mutate('todos.add', { id: crypto.randomUUID(), listId, title: 'Spam' })).status, 404, 'not a member')
    assert.equal((await cat.mutate('todos.toggle', { id })).status, 404, "cat can't touch ann's todo")
    const anon = await app.fetch(new Request('http://test/api/data/shape/todos.mine?offset=-1'))
    assert.equal(anon.status, 401, 'no user, no shape')
    assert.deepEqual(await bob.rows('todos.mine'), [])

    assert.equal((await bob.mutate('lists.join', { listId })).status, 200)
    assert.deepEqual((await bob.rows('todos.mine')).map((t) => t.title), ['Tickets'])
    assert.deepEqual((await bob.rows('lists.mine')).map((l) => l.name), ['Trip'])
    assert.deepEqual(await cat.rows('todos.mine'), [])

    assert.equal((await bob.mutate('lists.leave', { listId })).status, 200)
    assert.deepEqual(await bob.rows('todos.mine'), [])
  })
})

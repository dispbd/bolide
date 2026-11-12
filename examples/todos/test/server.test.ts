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

  test('each user syncs and changes only their own todos', async () => {
    const as = (uid: string, path: string, body?: unknown) =>
      app.fetch(
        new Request(`http://test${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { cookie: `uid=${uid}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
    const ann = crypto.randomUUID()
    const bob = crypto.randomUUID()
    const id = crypto.randomUUID()
    const added = await as(ann, '/api/data/mutate', { id: crypto.randomUUID(), name: 'todos.add', input: { id, title: 'Buy milk' } })
    assert.equal(added.status, 200)
    const stolen = await as(bob, '/api/data/mutate', { id: crypto.randomUUID(), name: 'todos.toggle', input: { id } })
    assert.equal(stolen.status, 404, "bob can't touch ann's todo")
    const anon = await app.fetch(new Request('http://test/api/data/shape/todos.mine?offset=-1'))
    assert.equal(anon.status, 401, 'no user, no shape')

    const rows = async (uid: string) => ((await (await as(uid, '/api/data/shape/todos.mine?offset=-1')).json()) as { value?: { title: string } }[]).flatMap((m) => (m.value ? [m.value.title] : []))
    assert.deepEqual(await rows(ann), ['Buy milk'])
    assert.deepEqual(await rows(bob), [])
  })
})

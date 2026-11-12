// Needs Postgres: `npm run db:up`, then `npm run test:int`.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { createApp, createLogger } from '@bolide/core'
import { defineJob, postgresQueue, Queue, queueModule } from '../../src/index.ts'

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide', { onnotice: () => {} })
const table = 'bolide_jobs_test'
const quiet = createLogger({ write: () => {} })

describe('postgresQueue', () => {
  before(async () => {
    await sql.unsafe(`drop table if exists ${table}`)
  })
  after(async () => {
    await sql.unsafe(`drop table if exists ${table}`)
    await sql.end()
  })

  test('creates its table, dedupes keys, retries and completes', async () => {
    const driver = postgresQueue(sql, { table })
    await driver.setup!()
    await driver.setup!() // idempotent
    assert.ok(await driver.push({ job: 'a', payload: '{"n":1}', runAt: new Date(), maxAttempts: 2, key: 'k' }))
    assert.equal(await driver.push({ job: 'a', payload: '{"n":2}', runAt: new Date(), maxAttempts: 2, key: 'k' }), undefined)
    const m = (await driver.reserve(['a'], 60_000))!
    assert.deepEqual([JSON.parse(m.payload), m.attempt, m.maxAttempts], [{ n: 1 }, 1, 2])
    assert.equal(await driver.reserve(['a'], 60_000), undefined, 'leased messages are not handed out twice')
    await driver.retry(m.id, new Date(Date.now() - 1), 'boom')
    const again = (await driver.reserve(['a'], 60_000))!
    assert.equal(again.attempt, 2)
    await driver.complete(again.id)
    const [row] = await sql.unsafe(`select status, error from ${table} where id = $1`, [again.id])
    assert.deepEqual(row, { status: 'done', error: null })
    await driver.prune!(new Date(Date.now() + 1000))
    assert.equal((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]!.n, 0)
  })

  test('concurrent workers never claim the same message', async () => {
    const driver = postgresQueue(sql, { table })
    for (let i = 0; i < 20; i++) await driver.push({ job: 'b', payload: String(i), runAt: new Date(), maxAttempts: 1 })
    const claimed = (await Promise.all(Array.from({ length: 30 }, () => driver.reserve(['b'], 60_000)))).filter(Boolean)
    assert.equal(claimed.length, 20)
    assert.equal(new Set(claimed.map((m) => m!.id)).size, 20)
  })

  test('runs jobs end to end through queueModule', async () => {
    const seen: number[] = []
    const Add = defineJob({ name: 'add', handler: () => void seen.push(1) })
    const app = await createApp({ modules: [queueModule({ jobs: [Add], driver: postgresQueue(sql, { table }) })], logger: quiet })
    await app.get(Queue).enqueue(Add)
    await app.get(Queue).enqueue(Add)
    await app.get(Queue).idle()
    assert.equal(seen.length, 2)
    await app.close()
  })

  test('rejects table names that are not plain identifiers', () => {
    assert.throws(() => postgresQueue(sql, { table: 'jobs; drop table x' }), /plain identifier/)
  })
})

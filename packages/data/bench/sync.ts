// Compares the Postgres-only sync sources: how fast a change reaches a live client, how many clients one
// change fans out to, and what each source costs writers. Run: `npm run bench:sync` (needs DATABASE_URL with
// wal_level=logical). Electric isn't here: it needs Docker; see docs/adr/0002-sync-sources.md.
import { performance } from 'node:perf_hooks'
import postgres from 'postgres'
import { defineShape, defineTable, t } from '../src/index.ts'
import { postgresSync, replicationSync, schemaSql, shapeColumns, whereSql, type SyncSource } from '../src/server/index.ts'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/bolide'
const N = Number(process.env.N ?? 200)
const CLIENTS = Number(process.env.CLIENTS ?? 100)
const WRITERS = Number(process.env.WRITERS ?? 8)
const SECONDS = Number(process.env.SECONDS ?? 3)

const items = defineTable('items', { id: t.integer().primaryKey(), owner: t.text(), title: t.text() })
const byOwner = (owner: string) => defineShape('items.owner', items, { where: () => ({ owner }) })

const admin = postgres(url, { onnotice: () => {} })
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]!
}
const ms = (x: number) => `${x.toFixed(1)} ms`

/** A live client of one shape that records when each title arrives. */
function liveClient(sync: SyncSource, owner: string, seen: Map<string, number>, stop: AbortSignal) {
  const shape = byOwner(owner)
  const rule = shape.where({ userId: undefined })
  const req = { table: 'items', columns: shapeColumns(shape), where: whereSql(items, rule === false ? {} : rule) }
  let offset = '-1'
  let handle = ''
  let ready!: () => void
  const loaded = new Promise<void>((r) => (ready = r))
  void (async () => {
    while (!stop.aborted) {
      const live = offset !== '-1'
      const protocol = new URLSearchParams({ offset, ...(handle ? { handle } : {}), ...(live ? { live: 'true' } : {}) })
      const res = await sync.fetchShape({ ...req, protocol, signal: stop }).catch(() => undefined)
      if (!res || stop.aborted) break
      if (res.status === 409) {
        offset = '-1'
        handle = ''
        continue
      }
      handle = res.headers.get('electric-handle')!
      offset = res.headers.get('electric-offset')!
      const now = performance.now()
      for (const m of (await res.json()) as { value?: { title: string } }[]) if (m.value && !seen.has(m.value.title)) seen.set(m.value.title, now)
      ready()
    }
  })()
  return loaded
}

async function run(name: string, make: (sql: postgres.Sql) => SyncSource) {
  const schema = `bolide_bench_${name.toLowerCase()}_${process.pid}`
  await admin.unsafe(`create schema ${schema}`)
  // Writers and the sync source get their own pools, as the cost to writers is what is measured.
  const sql = postgres(url, { onnotice: () => {}, max: WRITERS, connection: { search_path: schema } })
  const syncSql = postgres(url, { onnotice: () => {}, max: 10, connection: { search_path: schema } })
  await sql.unsafe(schemaSql([items]))
  const sync = make(syncSql)
  await sync.start?.(['items'])
  const stop = new AbortController()
  let id = 0
  try {
    // 1. One live client, sequential writes: commit → the client has it.
    const seen = new Map<string, number>()
    await liveClient(sync, 'solo', seen, stop.signal)
    const latency: number[] = []
    for (let i = 0; i < N; i++) {
      const title = `solo-${i}`
      await sql.unsafe(`insert into items values ($1, 'solo', $2)`, [++id, title])
      const committed = performance.now()
      while (!seen.has(title)) await new Promise((r) => setImmediate(r))
      latency.push(seen.get(title)! - committed)
    }
    const quietTps = await writeLoad(sql, 1_000_000)

    // 2. Fan-out: CLIENTS live clients on 10 owners' shapes; each change must reach a tenth of them.
    const perOwner = new Map<string, Map<string, number>>()
    const clients: Promise<void>[] = []
    for (let c = 0; c < CLIENTS; c++) {
      const owner = `o${c % 10}`
      const m = new Map<string, number>()
      perOwner.set(`${owner}#${c}`, m)
      clients.push(liveClient(sync, owner, m, stop.signal))
    }
    await Promise.all(clients)
    const fanLatency: number[] = []
    for (let i = 0; i < 50; i++) {
      const owner = `o${i % 10}`
      const title = `fan-${i}`
      await sql.unsafe(`insert into items values ($1, $2, $3)`, [++id, owner, title])
      const committed = performance.now()
      const mine = [...perOwner].filter(([k]) => k.startsWith(`${owner}#`)).map(([, m]) => m)
      while (!mine.every((m) => m.has(title))) await new Promise((r) => setImmediate(r))
      fanLatency.push(Math.max(...mine.map((m) => m.get(title)!)) - committed)
    }

    // 3. The same writers while those clients listen.
    const busyTps = await writeLoad(sql, 2_000_000)
    return { name, p50: pct(latency, 50), p95: pct(latency, 95), fan50: pct(fanLatency, 50), fan95: pct(fanLatency, 95), quietTps, busyTps }
  } finally {
    stop.abort()
    await new Promise((r) => setTimeout(r, 100))
    await sync.close?.()
    await syncSql.end()
    await sql.end()
    await admin.unsafe(`drop schema ${schema} cascade`)
  }
}

/** WRITERS connections inserting one row per transaction for SECONDS: transactions per second. */
async function writeLoad(sql: postgres.Sql, base: number) {
  let commits = 0
  const end = performance.now() + SECONDS * 1000
  await Promise.all(
    Array.from({ length: WRITERS }, async (_, w) => {
      for (let n = 0; performance.now() < end; n++) {
        await sql.unsafe(`insert into items values ($1, $2, 'w')`, [base + w * 100_000 + n, `o${n % 10}`])
        commits++
      }
    }),
  )
  return commits / SECONDS
}

/** Writers with no sync source: the baseline for the cost to writers. */
async function baseline() {
  const schema = `bolide_bench_none_${process.pid}`
  await admin.unsafe(`create schema ${schema}`)
  const sql = postgres(url, { onnotice: () => {}, max: WRITERS, connection: { search_path: schema } })
  await sql.unsafe(schemaSql([items]))
  const tps = await writeLoad(sql, 0)
  await sql.end()
  await admin.unsafe(`drop schema ${schema} cascade`)
  return tps
}

const slot = `bolide_bench_${process.pid}`
const results = [
  await run('postgresSync', (sql) => postgresSync(sql)),
  await run('replicationSync', (sql) => replicationSync(sql, { url, slot, publication: slot })),
]
await admin.unsafe(`select pg_drop_replication_slot($1) from pg_replication_slots where slot_name = $1`, [slot])
await admin.unsafe(`drop publication if exists ${slot}`)
const none = await baseline()
await admin.end()

console.log(`\n${N} sequential writes, ${CLIENTS} live clients, ${WRITERS} writers for ${SECONDS}s\n`)
console.log(`| Source | Commit → client (p50 / p95) | Commit → all ${CLIENTS / 10} clients of a shape (p50 / p95) | Inserts/s, 1 client | Inserts/s, ${CLIENTS} clients |`)
console.log('|---|---|---|---|---|')
for (const r of results) console.log(`| ${r.name} | ${ms(r.p50)} / ${ms(r.p95)} | ${ms(r.fan50)} / ${ms(r.fan95)} | ${Math.round(r.quietTps)} | ${Math.round(r.busyTps)} |`)
console.log(`| (no sync) | | | ${Math.round(none)} | |`)

// Measures how fast the UI sees a change (optimistic) versus when the server
// write has synced back through Electric (confirmed). Needs `npm run db:up`.
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { serve } from '@hono/node-server'
import postgres from 'postgres'
import { createServer } from '../server/app.ts'
import { mutators, type Todo } from '../app/mutators.ts'
import { createCrucibleClient } from '../core/client.ts'

const N = Number(process.env.N ?? 200)
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/crucible', { onnotice: () => {} })
const app = createServer({ sql, mutators, tables: ['todos'], electricUrl: process.env.ELECTRIC_URL ?? 'http://localhost:3000' })
const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s))
})
const baseUrl = `http://localhost:${(server.address() as any).port}`
const userId = randomUUID()
const client = createCrucibleClient({ baseUrl, userId, tables: ['todos'], mutators })
await client.ready()

const id = randomUUID()
await (await client.mutate('todos.create', { id, title: 'bench', owner_id: userId })).isPersisted.promise

const local: number[] = []
const confirmed: number[] = []
const roundtrip: number[] = []

for (let i = 0; i < N; i++) {
  const before = (client.collections.todos.get(id) as unknown as Todo).done
  const t0 = performance.now()
  const tx = await client.mutate('todos.toggle', { id })
  if ((client.collections.todos.get(id) as unknown as Todo).done === before) throw new Error('optimistic change not visible')
  local.push(performance.now() - t0)
  await tx.isPersisted.promise
  confirmed.push(performance.now() - t0)
}

// Baseline: the same mutation as a plain request, without waiting for sync.
for (let i = 0; i < N; i++) {
  const t0 = performance.now()
  const res = await fetch(`${baseUrl}/api/mutate`, {
    method: 'POST',
    headers: { 'x-user-id': userId, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'todos.toggle', args: { id } }),
  })
  await res.json()
  roundtrip.push(performance.now() - t0)
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
const row = (label: string, xs: number[]) =>
  `| ${label} | ${pct(xs, 50).toFixed(2)} | ${pct(xs, 95).toFixed(2)} | ${pct(xs, 99).toFixed(2)} |`
console.log(`N = ${N}, localhost, Node ${process.version}\n`)
console.log('| Что | p50, мс | p95, мс | p99, мс |\n|---|---|---|---|')
console.log(row('Изменение видно в UI (optimistic)', local))
console.log(row('Подтверждено: запись вернулась через Electric', confirmed))
console.log(row('Базовая линия: обычный POST без синхронизации', roundtrip))

await client.close()
server.close()
await sql.end()
process.exit(0)

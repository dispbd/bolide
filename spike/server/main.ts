import { serve } from '@hono/node-server'
import postgres from 'postgres'
import { createServer } from './app.ts'
import { mutators } from '../app/mutators.ts'

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54321/alloy')
const app = createServer({
  sql,
  mutators,
  tables: ['todos'],
  electricUrl: process.env.ELECTRIC_URL ?? 'http://localhost:3000',
})
const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, () => console.log(`alloy spike on http://localhost:${port}`))

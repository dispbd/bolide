import { listen } from '@bolide/core/node'
import { migrate, readMigrations } from '@bolide/data/server'
import postgres from 'postgres'
import { buildApp } from './app.ts'
import { ServerConfig } from './config.ts'

// The URL matches docker-compose.yml. ELECTRIC_URL switches sync from Postgres alone to Electric.
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/todos', { onnotice: () => {} })
// In development, apply new migrations at start; in production run `npm run db:migrate` as a deploy step.
if (process.env.NODE_ENV !== 'production') {
  const { applied } = await migrate(sql, await readMigrations('migrations'))
  if (applied.length) console.log(`applied ${applied.join(', ')}`)
}
const app = await buildApp({ sql, electricUrl: process.env.ELECTRIC_URL })
await listen(app, { port: app.get(ServerConfig).port })

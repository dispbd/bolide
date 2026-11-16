import { listen } from '@bolide/core/node'
import { migrate, readMigrations } from '@bolide/data/server'
import postgres from 'postgres'
import { buildApp } from './app.ts'
import { ServerConfig } from './config.ts'

// The URL matches docker-compose.yml.
const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/todos'
const sql = postgres(url, { onnotice: () => {} })
// In development, apply new migrations at start; in production run `npm run db:migrate` as a deploy step.
if (process.env.NODE_ENV !== 'production') {
  const { applied } = await migrate(sql, await readMigrations('migrations'))
  if (applied.length) console.log(`applied ${applied.join(', ')}`)
}
const app = await buildApp({ sql, url })
const server = await listen(app, { port: app.get(ServerConfig).port, handleSignals: false })
// Close the app, then the connection pool, which would otherwise keep the process alive.
const stop = async () => {
  await server.close()
  await sql.end({ timeout: 5 })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

import { Hono } from 'hono'
import type { Sql } from 'postgres'
import { MutatorError, validate, type MutatorRegistry } from '../core/mutator.ts'
import { createPgTx, inTransaction } from './pg-tx.ts'

export interface ServerOptions {
  sql: Sql
  mutators: MutatorRegistry
  tables: string[]
  electricUrl: string
}

// Query params the Electric client sends that we pass through unchanged.
const SHAPE_PARAMS = ['offset', 'handle', 'live', 'cursor', 'live_sse', 'log', 'columns', 'replica', 'subset__where', 'subset__limit', 'subset__offset', 'subset__order_by', 'subset__params']

const STATUS: Record<MutatorError['code'], 400 | 403 | 404 | 409> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
}

export function createServer({ sql, mutators, tables, electricUrl }: ServerOptions) {
  const allowed = new Set(tables)
  const app = new Hono<{ Variables: { userId: string } }>()

  // Spike auth: the user id comes from a header. Phase 2 replaces this with real sessions.
  app.use('/api/*', async (c, next) => {
    const userId = c.req.header('x-user-id')
    if (!userId) return c.json({ error: 'unauthorized' }, 401)
    c.set('userId', userId)
    await next()
  })

  app.post('/api/mutate', async (c) => {
    const { name, args } = await c.req.json<{ name: string; args: unknown }>()
    const mutator = mutators[name]
    if (!mutator) return c.json({ error: `unknown mutator ${name}` }, 404)
    try {
      const input = await validate(mutator.input, args)
      const txid = await inTransaction(sql, (tx) =>
        Promise.resolve(mutator.run({ tx: createPgTx(tx, allowed), input, userId: c.get('userId') })),
      )
      return c.json({ txid })
    } catch (e) {
      if (e instanceof MutatorError) return c.json({ error: e.message, code: e.code }, STATUS[e.code])
      throw e
    }
  })

  // Shapes go through the app server, so this is where read permissions will live.
  app.get('/api/shape/:table', async (c) => {
    const table = c.req.param('table')
    if (!allowed.has(table)) return c.json({ error: 'unknown table' }, 404)
    const url = new URL('/v1/shape', electricUrl)
    url.searchParams.set('table', table)
    for (const p of SHAPE_PARAMS) {
      const v = c.req.query(p)
      if (v !== undefined) url.searchParams.set(p, v)
    }
    const res = await fetch(url, { signal: c.req.raw.signal })
    const headers = new Headers(res.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    return new Response(res.body, { status: res.status, headers })
  })

  return app
}

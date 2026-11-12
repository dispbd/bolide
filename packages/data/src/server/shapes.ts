import type { ColumnDef } from '../columns.ts'
import type { AnyShape, Where } from '../shape.ts'
import type { AnyTable } from '../table.ts'

type Def = ColumnDef & { sqlName: string }
const q = (id: string) => `"${id}"`

export interface WhereSql {
  /** SQL with `$1`, `$2`... placeholders, or `''` for every row. */
  sql: string
  params: string[]
}

const ops = { ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

// Electric takes params as text; the column type decides how Postgres reads them.
const text = (v: unknown) => String(v)

/**
 * Builds the SQL for a shape's where object. Column names come from the table, never from the request,
 * and every value is a parameter.
 */
export function whereSql(table: AnyTable, where: Where<AnyTable>): WhereSql {
  const parts: string[] = []
  const params: string[] = []
  const param = (def: Def, v: unknown) => {
    if (v === undefined) throw new TypeError(`where on ${table.name}: a value is undefined; leave the key out instead.`)
    params.push(text(v))
    return `$${params.length}`
  }
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue
    const def = table.columns[key] as Def | undefined
    if (!def) throw new TypeError(`where on ${table.name}: no column "${key}".`)
    // Sync engines filter on scalar columns; JSON filters belong in a column of their own.
    if (def.kind === 'json') throw new TypeError(`where on ${table.name}.${key}: json columns can't be filtered on.`)
    const col = q(def.sqlName)
    if (cond === null) parts.push(`${col} is null`)
    else if (typeof cond === 'object') {
      const entries = Object.entries(cond as Record<string, unknown>)
      if (entries.length !== 1) throw new TypeError(`where on ${table.name}.${key}: use one of in, ne, gt, gte, lt, lte per column.`)
      const [op, v] = entries[0]!
      if (op === 'in') {
        const list = v as unknown[]
        if (!Array.isArray(list)) throw new TypeError(`where on ${table.name}.${key}: "in" takes an array.`)
        parts.push(list.length ? `${col} in (${list.map((x) => param(def, x)).join(', ')})` : 'false')
      } else if (op === 'ne' && v === null) parts.push(`${col} is not null`)
      else if (op in ops) parts.push(`${col} ${ops[op as keyof typeof ops]} ${param(def, v)}`)
      else throw new TypeError(`where on ${table.name}.${key}: unknown operator "${op}".`)
    } else parts.push(`${col} = ${param(def, cond)}`)
  }
  return { sql: parts.join(' and '), params }
}

/** Where shapes come from. Electric is the production source; tests can pass their own. */
export interface SyncSource {
  /** Answers a shape request: `table`, `columns` and `where` are already decided by the server. */
  fetchShape(request: { table: string; columns: string[]; where: WhereSql; protocol: URLSearchParams; signal: AbortSignal }): Promise<Response>
}

// The Electric client's protocol params; anything else from the browser is dropped.
const PROTOCOL = ['offset', 'handle', 'live', 'cursor', 'live_sse', 'log', 'replica', 'experimental_live_sse']

export interface ElectricOptions {
  /** Electric's base URL, e.g. `http://localhost:3000`. */
  url: string
  /** Electric Cloud's source id and secret, sent as query params; keep them on the server. */
  sourceId?: string
  secret?: string
  /** Swappable for tests. */
  fetch?: typeof fetch
}

/** Shapes from an Electric sync service, proxied through the app so read rules always apply. */
export function electric(options: ElectricOptions): SyncSource {
  const doFetch = options.fetch ?? fetch
  return {
    async fetchShape({ table, columns, where, protocol, signal }) {
      const url = new URL('/v1/shape', options.url)
      for (const p of PROTOCOL) {
        const v = protocol.get(p)
        if (v !== null) url.searchParams.set(p, v)
      }
      url.searchParams.set('table', table)
      url.searchParams.set('columns', columns.map(q).join(','))
      if (where.sql) {
        url.searchParams.set('where', where.sql)
        where.params.forEach((v, i) => url.searchParams.set(`params[${i + 1}]`, v))
      }
      if (options.sourceId) url.searchParams.set('source_id', options.sourceId)
      if (options.secret) url.searchParams.set('secret', options.secret)
      const res = await doFetch(url, { signal })
      const headers = new Headers(res.headers)
      // fetch already decoded the body.
      headers.delete('content-encoding')
      headers.delete('content-length')
      // Rows depend on who asks, so no shared cache may keep them.
      const cc = headers.get('cache-control')
      if (cc) headers.set('cache-control', cc.replace(/\bpublic\b/, 'private'))
      headers.append('vary', 'cookie, authorization')
      return new Response(res.body, { status: res.status, headers })
    },
  }
}

/** The SQL names Electric is asked for. */
export function shapeColumns(shape: AnyShape): string[] {
  return (shape.columns as string[]).map((k) => (shape.table.columns[k] as Def).sqlName)
}

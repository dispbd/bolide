import assert from 'node:assert/strict'
import type { AnyShape } from '../../src/index.ts'
import { shapeColumns, whereSql, type SyncSource } from '../../src/server/index.ts'

type Msg = { key?: string; value?: Record<string, unknown>; headers: { operation?: string; control?: string; txids?: number[] } }

/** A minimal shape client for sync source tests: loads, then follows the stream, keeping rows by key. */
export function follower(source: () => SyncSource, shape: AnyShape, userId?: string) {
  const rule = shape.where({ userId })
  const req = { table: shape.table.name, columns: shapeColumns(shape), where: whereSql(shape.table, rule === false ? {} : rule) }
  const rows = new Map<string, Record<string, unknown>>()
  const txids: number[] = []
  let offset = '-1'
  let handle = ''
  async function poll(live = false) {
    const protocol = new URLSearchParams({ offset, ...(handle ? { handle } : {}), ...(live ? { live: 'true' } : {}) })
    const res = await source().fetchShape({ ...req, protocol, signal: AbortSignal.timeout(5000) })
    if (res.status === 409) return 'must-refetch' as const
    assert.equal(res.status, 200, await res.clone().text())
    handle = res.headers.get('electric-handle')!
    offset = res.headers.get('electric-offset')!
    for (const m of (await res.json()) as Msg[]) {
      if (m.headers.txids) txids.push(...m.headers.txids)
      if (m.headers.operation === 'delete') rows.delete(m.key!)
      else if (m.headers.operation) rows.set(m.key!, { ...rows.get(m.key!), ...m.value })
    }
    return res.headers.has('electric-up-to-date') ? ('up-to-date' as const) : ('more' as const)
  }
  return {
    rows,
    txids,
    offset: () => offset,
    poll,
    /** Polls until up to date. */
    async catchUp() {
      for (let i = 0; i < 100; i++) {
        const r = await poll()
        if (r !== 'more') return r
      }
      throw new Error('never caught up')
    },
    /** What a client does on must-refetch: forget everything and load again. */
    async reload() {
      rows.clear()
      offset = '-1'
      handle = ''
      return this.catchUp()
    },
    titles: () => [...rows.values()].map((r) => r.title).sort(),
  }
}
export type Follower = ReturnType<typeof follower>

import type { MutatorTx, Row } from './mutator.ts'

export type Op =
  | { type: 'insert'; table: string; row: Row }
  | { type: 'update'; table: string; id: string; patch: Record<string, unknown> }
  | { type: 'delete'; table: string; id: string }

/**
 * Client-side tx: reads come from the local store, writes are recorded as ops.
 * Reads see the mutator's own earlier writes, so a mutator behaves the same
 * as it would inside a real database transaction.
 */
export function createRecordingTx(read: (table: string, id: string) => Row | undefined) {
  const ops: Op[] = []
  const overlay = new Map<string, Row | null>()
  const key = (table: string, id: string) => `${table}\u0000${id}`

  const current = (table: string, id: string): Row | undefined => {
    const k = key(table, id)
    if (overlay.has(k)) return overlay.get(k) ?? undefined
    return read(table, id)
  }

  const tx: MutatorTx = {
    side: 'client',
    async get<T extends Row = Row>(table: string, id: string) {
      const row = current(table, id)
      return row ? ({ ...row } as T) : undefined
    },
    async insert(table, row) {
      ops.push({ type: 'insert', table, row: { ...row } })
      overlay.set(key(table, row.id), { ...row })
    },
    async update(table, id, patch) {
      const row = current(table, id)
      if (!row) throw new Error(`${table}/${id} not found`)
      ops.push({ type: 'update', table, id, patch: { ...patch } })
      overlay.set(key(table, id), { ...row, ...patch })
    },
    async delete(table, id) {
      ops.push({ type: 'delete', table, id })
      overlay.set(key(table, id), null)
    },
  }

  return { tx, ops }
}

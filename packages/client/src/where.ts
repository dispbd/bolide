import type { AnyTable, ColumnDef, Condition, Where } from '@bolide/data'

type Kind = ColumnDef['kind']

/** Compares the way Postgres would for the column's type. Decimals and timestamps travel as strings. */
const compare = (kind: Kind | undefined, a: unknown, b: unknown) => {
  if (kind === 'integer' || kind === 'real' || kind === 'numeric') return Number(a) - Number(b)
  if (kind === 'timestamp' || kind === 'date') return Date.parse(String(a)) - Date.parse(String(b))
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function test(kind: Kind | undefined, value: unknown, cond: Condition<unknown>): boolean {
  if (cond === null) return value === null || value === undefined
  if (typeof cond !== 'object') return value !== null && value !== undefined && compare(kind, value, cond) === 0
  const [op, v] = Object.entries(cond)[0] as [string, unknown]
  if (op === 'ne') return v === null ? value !== null && value !== undefined : value !== null && value !== undefined && compare(kind, value, v) !== 0
  if (value === null || value === undefined) return false
  if (op === 'in') return (v as unknown[]).some((x) => compare(kind, value, x) === 0)
  const c = compare(kind, value, v)
  return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0
}

/** Whether a row satisfies a shape's where object, the way the server's SQL would decide. */
export function matches(table: AnyTable, row: Record<string, unknown>, where: Where<AnyTable>): boolean {
  // An undefined condition is an error on the server; here it matches nothing (fail closed).
  return Object.entries(where).every(([k, cond]) => cond !== undefined && test((table.columns[k] as ColumnDef | undefined)?.kind, row[k], cond as Condition<unknown>))
}

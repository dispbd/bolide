import type { AnyTable, Condition, Where } from '@bolide/data'

const compare = (a: unknown, b: unknown) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  // Decimals are strings; timestamps are ISO strings and compare as instants.
  const na = Number(a)
  const nb = Number(b)
  if (typeof a === 'string' && typeof b === 'string' && a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  const da = typeof a === 'string' ? Date.parse(a) : NaN
  const db = typeof b === 'string' ? Date.parse(b) : NaN
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function test(value: unknown, cond: Condition<unknown>): boolean {
  if (cond === null) return value === null || value === undefined
  if (typeof cond !== 'object') return value !== null && value !== undefined && compare(value, cond) === 0
  const [op, v] = Object.entries(cond)[0] as [string, unknown]
  if (op === 'ne') return v === null ? value !== null && value !== undefined : value !== null && value !== undefined && compare(value, v) !== 0
  if (value === null || value === undefined) return false
  if (op === 'in') return (v as unknown[]).some((x) => compare(value, x) === 0)
  const c = compare(value, v)
  return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0
}

/** Whether a row satisfies a shape's where object, the way the server's SQL would decide. */
export function matches(_table: AnyTable, row: Record<string, unknown>, where: Where<AnyTable>): boolean {
  return Object.entries(where).every(([k, cond]) => cond === undefined || test(row[k], cond as Condition<unknown>))
}

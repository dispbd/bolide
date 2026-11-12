import type { StandardSchemaV1 } from '@standard-schema/spec'
import { generate, type Column, type ColumnDef } from './columns.ts'

export type Columns = Record<string, Column<any, boolean, boolean, boolean>>

type Value<C> = C extends Column<infer T, infer N, boolean, boolean> ? (N extends true ? T | null : T) : never
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type OptionalKeys<C extends Columns> = { [K in keyof C]: C[K] extends Column<any, boolean, true, boolean> ? K : never }[keyof C]
type PrimaryKeyOf<C extends Columns> = { [K in keyof C]: C[K] extends Column<any, boolean, boolean, true> ? K : never }[keyof C] & string

/** A row as it is read: every column, `null` where the column is nullable. */
export type RowOf<C extends Columns> = Simplify<{ -readonly [K in keyof C]: Value<C[K]> }>
/** A row as it is inserted: columns with a default or `nullable()` may be left out. */
export type InsertOf<C extends Columns> = Simplify<
  { -readonly [K in Exclude<keyof C, OptionalKeys<C>>]: Value<C[K]> } & { -readonly [K in OptionalKeys<C>]?: Value<C[K]> }
>

export interface Table<N extends string = string, C extends Columns = Columns> extends StandardSchemaV1<InsertOf<C>, RowOf<C>> {
  readonly name: N
  readonly columns: { readonly [K in keyof C]: ColumnDef & { readonly sqlName: string } }
  /** The key of the primary key column. */
  readonly primaryKey: PrimaryKeyOf<C>
  /** Type carriers for `Row<typeof t>`, `Insert<typeof t>`; undefined at run time. */
  readonly $row: RowOf<C>
  readonly $insert: InsertOf<C>
}

export type AnyTable = Table<string, any>
/** The row type of a table: `Row<typeof todos>`. */
export type Row<T extends AnyTable> = T['$row']
/** What an insert takes: `Insert<typeof todos>`. */
export type Insert<T extends AnyTable> = T['$insert']
/** What an update takes: any columns but the primary key. */
export type Patch<T extends AnyTable> = Partial<Omit<Row<T>, T['primaryKey']>>

const identifier = /^[a-z_][a-z0-9_]{0,62}$/

/** `ownerId` → `owner_id`. */
export function snake(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase()
}

export class SchemaError extends Error {
  override name = 'SchemaError'
}

/**
 * Defines a table shared by the server and the browser. Keys are camelCase in code and snake_case in SQL.
 *
 * ```ts
 * export const todos = defineTable('todos', {
 *   id: t.uuid().primaryKey().defaultRandom(),
 *   title: t.text(),
 *   done: t.boolean().default(false),
 *   ownerId: t.uuid().references(() => users),
 * })
 * type Todo = Row<typeof todos>
 * ```
 */
export function defineTable<const N extends string, const C extends Columns>(name: N, columns: C): Table<N, C> {
  const fail = (why: string): never => {
    throw new SchemaError(`table "${name}": ${why}`)
  }
  if (!identifier.test(name)) fail('the name must be a lowercase SQL identifier (letters, digits, _), at most 63 characters.')
  const defs: Record<string, ColumnDef & { sqlName: string }> = {}
  const sqlNames = new Set<string>()
  for (const [key, column] of Object.entries(columns)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`column key "${key}" must be a plain identifier.`)
    const sqlName = column.def.sqlName ?? snake(key)
    if (!identifier.test(sqlName)) fail(`column "${key}" maps to "${sqlName}", which is not a lowercase SQL identifier. Name it with .named('...').`)
    if (sqlNames.has(sqlName)) fail(`two columns map to "${sqlName}".`)
    sqlNames.add(sqlName)
    defs[key] = { ...column.def, sqlName }
  }
  const keys = Object.keys(defs)
  const pks = keys.filter((k) => defs[k]!.primaryKey)
  if (pks.length !== 1) fail(`needs exactly one primary key column (mark it with .primaryKey()), found ${pks.length ? pks.join(', ') : 'none'}. Sync addresses rows by it.`)
  const primaryKey = pks[0]!
  if (defs[primaryKey]!.nullable) fail(`the primary key "${primaryKey}" can't be nullable.`)

  const table = {
    name,
    columns: defs,
    primaryKey,
    '~standard': {
      version: 1,
      vendor: 'bolide',
      validate: (value: unknown) => {
        const issues = checkInsert(table as unknown as AnyTable, value)
        return issues.length ? { issues } : { value: withDefaults(table as unknown as AnyTable, value as Record<string, unknown>) }
      },
    },
  }
  return Object.freeze(table) as unknown as Table<N, C>
}

type Issue = StandardSchemaV1.Issue

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkColumns(table: AnyTable, value: Record<string, unknown>, required: (def: ColumnDef) => boolean): Issue[] {
  const issues: Issue[] = []
  for (const k of Object.keys(value)) if (!(k in table.columns)) issues.push({ message: `unknown column "${k}" in ${table.name}`, path: [k] })
  for (const [k, def] of Object.entries(table.columns) as [string, ColumnDef][]) {
    const v = value[k]
    if (v === undefined) {
      if (required(def)) issues.push({ message: `${table.name}.${k} is required`, path: [k] })
      continue
    }
    if (v === null) {
      if (!def.nullable) issues.push({ message: `${table.name}.${k} can't be null`, path: [k] })
      continue
    }
    const why = def.check(v)
    if (why) issues.push({ message: `${table.name}.${k}: ${why}`, path: [k] })
  }
  return issues
}

/** Problems with a row to insert; empty when it is fine. */
export function checkInsert(table: AnyTable, value: unknown): Issue[] {
  if (!isRecord(value)) return [{ message: `a ${table.name} row must be an object` }]
  return checkColumns(table, value, (def) => !def.nullable && def.default === undefined)
}

/** Problems with an update; the primary key can't change. */
export function checkPatch(table: AnyTable, value: unknown): Issue[] {
  if (!isRecord(value)) return [{ message: `a ${table.name} update must be an object` }]
  const issues = checkColumns(table, value, () => false)
  if (value[table.primaryKey] !== undefined) issues.push({ message: `${table.name}.${table.primaryKey} is the primary key and can't be updated`, path: [table.primaryKey] })
  return issues
}

/** A full row from an insert: defaults filled in, left-out nullable columns set to `null`. */
export function withDefaults<T extends AnyTable>(table: T, value: Record<string, unknown>): Row<T> {
  const row: Record<string, unknown> = {}
  for (const [k, def] of Object.entries(table.columns) as [string, ColumnDef][]) {
    const v = value[k]
    if (v !== undefined) row[k] = v
    else if (def.default && 'value' in def.default) row[k] = structuredClone(def.default.value)
    else if (def.default) row[k] = generate(def.default.generated)
    else row[k] = null
  }
  return row as Row<T>
}

/** Keys to SQL names: `{ ownerId }` → `{ owner_id }`. */
export function toSqlRow(table: AnyTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[(table.columns[k] as { sqlName: string }).sqlName] = v
  return out
}

/** SQL names to keys, for rows read from the database or a sync stream. Unknown columns are dropped. */
export function fromSqlRow<T extends AnyTable>(table: T, row: Record<string, unknown>): Row<T> {
  const out: Record<string, unknown> = {}
  for (const [k, def] of Object.entries(table.columns) as [string, { sqlName: string }][]) if (def.sqlName in row) out[k] = row[def.sqlName]
  return out as Row<T>
}

/**
 * Brings values from a database driver or a sync stream to the row format: timestamps as ISO strings in UTC,
 * dates as `YYYY-MM-DD`, decimals as strings. Works on keyed rows (after `fromSqlRow`).
 */
export function normalizeRow<T extends AnyTable>(table: T, row: Record<string, unknown>): Row<T> {
  const out: Record<string, unknown> = { ...row }
  for (const [k, def] of Object.entries(table.columns) as [string, ColumnDef][]) {
    const v = out[k]
    if (v === null || v === undefined) continue
    if (def.kind === 'timestamp') out[k] = new Date(v instanceof Date ? v : String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString()
    else if (def.kind === 'date' && v instanceof Date) out[k] = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    else if (def.kind === 'numeric' && typeof v === 'number') out[k] = String(v)
  }
  return out as Row<T>
}

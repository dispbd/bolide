import type { AnyTable, Row } from './table.ts'

/** A comparison on one column. A plain value means equality; `null` means IS NULL. */
export type Condition<V> = V | null | { in: readonly V[] | Query<V> } | { ne: V | null } | { gt: V } | { gte: V } | { lt: V } | { lte: V }

/** One column of the rows of another table that match `where`: the list for `{ in: query(...) }`. */
export interface Query<V = unknown> {
  readonly kind: 'query'
  readonly table: AnyTable
  readonly column: string
  readonly where: Where<AnyTable>
  /** Type carrier for the column's values; undefined at run time. */
  readonly $value?: V
}

/**
 * Rows of another table, for a rule like "todos of the lists I'm a member of":
 *
 * ```ts
 * defineShape('todos.shared', todos, {
 *   where: ({ userId }) => (userId ? { listId: { in: query(members, 'listId', { userId }) } } : false),
 * })
 * ```
 *
 * When a `members` row of that user changes, clients of the shape load it again, so todos appear and vanish
 * as the user joins and leaves lists. Needs `replicationSync()` or `postgresSync()`.
 */
export function query<T extends AnyTable, K extends keyof Row<T> & string>(table: T, column: K, where: Where<T> = {}): Query<Exclude<Row<T>[K], null>> {
  if (!Object.hasOwn(table.columns, column)) throw new TypeError(`query(${table.name}): no column "${column}".`)
  return Object.freeze({ kind: 'query', table, column, where: where as Where<AnyTable> })
}

/** Whether `v` is a `query(...)`. */
export const isQuery = (v: unknown): v is Query => typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'query'

/** Conditions on columns, joined with AND: `{ ownerId: userId, done: false }`. */
export type Where<T extends AnyTable> = { [K in keyof Row<T>]?: Condition<Exclude<Row<T>[K], null>> }

export interface ShapeContext {
  /** The signed-in user's id from `dataModule({ userId })`, or undefined. */
  userId: string | undefined
}

export interface Shape<N extends string = string, T extends AnyTable = AnyTable, K extends keyof Row<T> = keyof Row<T>> {
  readonly kind: 'shape'
  readonly name: N
  readonly table: T
  /** The columns the browser gets; always includes the primary key. */
  readonly columns: readonly K[]
  /**
   * Which rows a request may read. Runs on the server for every request. Return `false` to refuse (403),
   * for example when nobody is signed in.
   */
  readonly where: (ctx: ShapeContext) => Where<T> | false
  /** Type carrier for the rows the browser holds; undefined at run time. */
  readonly $row: Pick<Row<T>, K | T['primaryKey']>
}

export type AnyShape = Shape<string, AnyTable, any>
export type ShapeRow<S extends AnyShape> = S['$row']

export interface ShapeOptions<T extends AnyTable, K extends keyof Row<T>> {
  /** Rows a request may read. Default: every row, to everyone. */
  where?: (ctx: ShapeContext) => Where<T> | false
  /** Columns to send. Default: all. Leave out what the browser must not see (password hashes, internal notes). */
  columns?: readonly K[]
}

const shapeName = /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/

/**
 * A set of rows the browser keeps in sync. The browser asks for a shape by name; it never sends a table or a filter,
 * so read rules live on the server, next to the data.
 *
 * ```ts
 * export const myTodos = defineShape('todos.mine', todos, {
 *   where: ({ userId }) => (userId ? { ownerId: userId } : false),
 * })
 * ```
 */
export function defineShape<const N extends string, T extends AnyTable, K extends keyof Row<T> = keyof Row<T>>(name: N, table: T, options: ShapeOptions<T, K> = {}): Shape<N, T, K> {
  if (!shapeName.test(name)) throw new TypeError(`shape name "${name}" must be dotted words like "todos.mine".`)
  const keys = Object.keys(table.columns)
  const columns = (options.columns ?? keys) as readonly string[]
  for (const c of columns) if (!keys.includes(c)) throw new TypeError(`shape "${name}": ${table.name} has no column "${c}".`)
  const withKey = columns.includes(table.primaryKey) ? columns : [table.primaryKey, ...columns]
  return Object.freeze({ kind: 'shape', name, table, columns: withKey as readonly K[], where: options.where ?? (() => ({})) }) as unknown as Shape<N, T, K>
}

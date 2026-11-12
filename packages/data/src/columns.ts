/**
 * Column builders. Each column knows its TypeScript type, its SQL type and how to check a value,
 * so one table definition gives row types, validation and DDL.
 */

/** What a foreign key needs from the table it points at. */
export interface TableRef {
  readonly name: string
  readonly primaryKey: string
  readonly columns: { readonly [key: string]: { readonly sqlName: string } }
}

export type ColumnKind = 'text' | 'integer' | 'real' | 'numeric' | 'boolean' | 'uuid' | 'timestamp' | 'date' | 'json' | 'enum'

/** A default the client and the server compute the same way. */
export type GeneratedDefault = 'random-uuid' | 'now'

export interface ColumnDef {
  readonly kind: ColumnKind
  readonly sqlType: string
  readonly nullable: boolean
  readonly primaryKey: boolean
  readonly unique: boolean
  /** A literal default, or a generated one. Absent when the column has no default. */
  readonly default?: { value: unknown } | { generated: GeneratedDefault }
  readonly values?: readonly string[]
  readonly references?: () => TableRef
  /** The SQL name; set from the key by `defineTable` (camelCase becomes snake_case) unless given. */
  readonly sqlName?: string
  readonly check: (value: unknown) => string | undefined
}

/**
 * A column with its value type `T`, whether it may be null `N`, whether inserts may leave it out `O`,
 * and whether it is the primary key `P`.
 * The type parameters only carry types; everything at run time is in `def`.
 */
export class Column<T, N extends boolean = false, O extends boolean = false, P extends boolean = false> {
  declare readonly _type: T
  declare readonly _nullable: N
  declare readonly _optional: O
  declare readonly _primaryKey: P
  constructor(readonly def: ColumnDef) {}

  private with(patch: Partial<ColumnDef>) {
    return new Column({ ...this.def, ...patch })
  }

  /** Allows `null`. Inserts may leave the column out; it is then `null`. */
  nullable(): Column<T, true, true, P> {
    return this.with({ nullable: true }) as never
  }
  /** Inserts may leave the column out; it then gets `value`. */
  default(value: T): Column<T, N, true, P> {
    const why = this.def.check(value)
    if (why) throw new TypeError(`default ${JSON.stringify(value)}: ${why}`)
    return this.with({ default: { value } }) as never
  }
  primaryKey(): Column<T, N, O, true> {
    return this.with({ primaryKey: true }) as never
  }
  unique(): Column<T, N, O, P> {
    return this.with({ unique: true }) as never
  }
  /** Sets the SQL column name instead of the snake_case of the key. */
  named(sqlName: string): Column<T, N, O, P> {
    return this.with({ sqlName }) as never
  }
  /** Uuid columns: inserts may leave it out; it gets `crypto.randomUUID()`, computed where the insert runs. */
  defaultRandom(this: Column<string, N, O, P>): Column<T, N, true, P> {
    if (this.def.kind !== 'uuid') throw new TypeError(`defaultRandom() is for uuid columns, not ${this.def.kind}.`)
    return this.with({ default: { generated: 'random-uuid' } }) as never
  }
  /** Timestamp columns: inserts may leave it out; it gets the current time, computed where the insert runs. */
  defaultNow(this: Column<string, N, O, P>): Column<T, N, true, P> {
    if (this.def.kind !== 'timestamp') throw new TypeError(`defaultNow() is for timestamp columns, not ${this.def.kind}.`)
    return this.with({ default: { generated: 'now' } }) as never
  }
  /** A foreign key to another table's primary key. A function, so tables can refer to each other. */
  references(table: () => TableRef): Column<T, N, O, P> {
    return this.with({ references: table }) as never
  }
}

const base = (kind: ColumnKind, sqlType: string, check: (v: unknown) => string | undefined, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  kind,
  sqlType,
  nullable: false,
  primaryKey: false,
  unique: false,
  check,
  ...extra,
})

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/
const isoDate = /^\d{4}-\d{2}-\d{2}$/

const expect = (ok: boolean, what: string) => (ok ? undefined : `expected ${what}`)

export const t = {
  text: () => new Column<string>(base('text', 'text', (v) => expect(typeof v === 'string', 'a string'))),
  /** A 32-bit integer. */
  integer: () => new Column<number>(base('integer', 'integer', (v) => expect(Number.isInteger(v) && Math.abs(v as number) <= 2 ** 31 - 1, 'a 32-bit integer'))),
  /** A double-precision number. */
  real: () => new Column<number>(base('real', 'double precision', (v) => expect(typeof v === 'number' && Number.isFinite(v), 'a finite number'))),
  /** Exact decimals (money), kept as a string such as `"12.50"` so no precision is lost on the way. */
  numeric: () => new Column<string>(base('numeric', 'numeric', (v) => expect(typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v), 'a decimal string such as "12.50"'))),
  boolean: () => new Column<boolean>(base('boolean', 'boolean', (v) => expect(typeof v === 'boolean', 'true or false'))),
  uuid: () => new Column<string>(base('uuid', 'uuid', (v) => expect(typeof v === 'string' && uuidPattern.test(v), 'a uuid'))),
  /** A point in time as an ISO 8601 string with a zone (`2026-11-12T10:00:00.000Z`): JSON-safe on every hop. */
  timestamp: () => new Column<string>(base('timestamp', 'timestamptz', (v) => expect(typeof v === 'string' && isoTimestamp.test(v) && !Number.isNaN(Date.parse(v)), 'an ISO 8601 timestamp with a zone'))),
  /** A calendar date as `YYYY-MM-DD`. */
  date: () => new Column<string>(base('date', 'date', (v) => expect(typeof v === 'string' && isoDate.test(v) && !Number.isNaN(Date.parse(v)), 'a date as YYYY-MM-DD'))),
  /** Any JSON value, stored as `jsonb`. The type is yours to state: `t.json<{ tags: string[] }>()`. */
  json: <T = unknown>() => new Column<T>(base('json', 'jsonb', (v) => expect(v !== undefined && isJson(v), 'a JSON value'))),
  /** One of a fixed set of strings, stored as `text` with a check constraint. */
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    new Column<V[number]>(base('enum', 'text', (v) => expect(typeof v === 'string' && values.includes(v), `one of ${values.map((x) => JSON.stringify(x)).join(', ')}`), { values })),
}

function isJson(v: unknown, depth = 0): boolean {
  if (depth > 100) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1))
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    return (proto === Object.prototype || proto === null) && Object.values(v).every((x) => isJson(x, depth + 1))
  }
  return false
}

/** The value of a generated default, computed on whichever side runs the insert. */
export function generate(kind: GeneratedDefault): string {
  return kind === 'random-uuid' ? crypto.randomUUID() : new Date().toISOString()
}

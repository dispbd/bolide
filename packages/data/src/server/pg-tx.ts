import type { ColumnDef } from '../columns.ts'
import { MutatorError, type MutatorTx } from '../mutator.ts'
import { checkInsert, checkPatch, fromSqlRow, normalizeRow, withDefaults, type AnyTable } from '../table.ts'
import type { SqlQuery } from './migrate.ts'

type Def = ColumnDef & { sqlName: string }

const q = (id: string) => `"${id}"`
const defs = (table: AnyTable) => Object.entries(table.columns) as [string, Def][]

// numeric and date as text keep their exact value; the rest is normalised after reading.
const selectList = (table: AnyTable) =>
  defs(table)
    .map(([, d]) => (d.kind === 'numeric' || d.kind === 'date' ? `${q(d.sqlName)}::text as ${q(d.sqlName)}` : q(d.sqlName)))
    .join(', ')

// A JSON value goes in as text and is cast, or the driver would encode a string value a second time.
const param = (d: Def, i: number) => (d.kind === 'json' ? `$${i}::text::jsonb` : `$${i}`)
const value = (d: Def, v: unknown) => (d.kind === 'json' && v !== null ? JSON.stringify(v) : v)

function invalid(table: AnyTable, issues: { message: string }[]): never {
  throw new MutatorError('invalid_input', issues.map((i) => i.message).join('; '))
}

/**
 * The server's `MutatorTx`: the same calls as in the browser, on a Postgres transaction.
 * Values are checked against the table before they reach SQL, so a mutator can't write what the schema forbids.
 */
export function postgresTx(sql: SqlQuery, tables: ReadonlySet<AnyTable>): MutatorTx {
  const known = (table: AnyTable) => {
    // A programming mistake, not a bad request: it surfaces as a 500 and in the log.
    if (!tables.has(table)) throw new Error(`table "${table.name}" is not in dataModule({ tables }).`)
    return table
  }
  const pk = (table: AnyTable) => q((table.columns[table.primaryKey] as Def).sqlName)
  return {
    async get(table, id) {
      known(table)
      // FOR UPDATE: a mutator that reads, then writes, doesn't lose a concurrent change.
      const [row] = await sql.unsafe(`select ${selectList(table)} from ${q(table.name)} where ${pk(table)} = $1 for update`, [id])
      return row ? normalizeRow(table, fromSqlRow(table, row)) : undefined
    },
    async insert(table, row) {
      known(table)
      const issues = checkInsert(table, row)
      if (issues.length) invalid(table, issues)
      const full = withDefaults(table, row as Record<string, unknown>)
      const cols = defs(table)
      await sql.unsafe(
        `insert into ${q(table.name)} (${cols.map(([, d]) => q(d.sqlName)).join(', ')}) values (${cols.map(([, d], i) => param(d, i + 1)).join(', ')})`,
        cols.map(([k, d]) => value(d, (full as Record<string, unknown>)[k])),
      )
      return full
    },
    async update(table, id, patch) {
      known(table)
      const issues = checkPatch(table, patch)
      if (issues.length) invalid(table, issues)
      const set = defs(table).filter(([k]) => (patch as Record<string, unknown>)[k] !== undefined)
      if (!set.length) return
      const rows = await sql.unsafe(
        `update ${q(table.name)} set ${set.map(([, d], i) => `${q(d.sqlName)} = ${param(d, i + 2)}`).join(', ')} where ${pk(table)} = $1 returning 1`,
        [id, ...set.map(([k, d]) => value(d, (patch as Record<string, unknown>)[k]))],
      )
      if (!rows.length) throw new MutatorError('not_found', `${table.name} ${String(id)} does not exist.`)
    },
    async delete(table, id) {
      known(table)
      await sql.unsafe(`delete from ${q(table.name)} where ${pk(table)} = $1`, [id])
    },
  }
}

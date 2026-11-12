import { SchemaError, type AnyTable } from '../table.ts'
import type { ColumnDef } from '../columns.ts'

const quote = (id: string) => `"${id}"`

function literal(def: ColumnDef, value: unknown): string {
  if (value === null) return 'null'
  if (def.kind === 'json') return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function columnSql(table: AnyTable, key: string): string {
  const def = table.columns[key] as ColumnDef & { sqlName: string }
  const parts = [quote(def.sqlName), def.sqlType]
  if (def.primaryKey) parts.push('primary key')
  else if (!def.nullable) parts.push('not null')
  if (def.unique && !def.primaryKey) parts.push('unique')
  if (def.default && 'value' in def.default) parts.push(`default ${literal(def, def.default.value)}`)
  // Generated defaults are filled in by whichever side runs the insert; the SQL default covers raw inserts.
  else if (def.default) parts.push(def.default.generated === 'now' ? 'default now()' : 'default gen_random_uuid()')
  if (def.values) parts.push(`check (${quote(def.sqlName)} in (${def.values.map((v) => literal(def, v)).join(', ')}))`)
  if (def.references) {
    const target = def.references()
    parts.push(`references ${quote(target.name)} (${quote(target.columns[target.primaryKey]!.sqlName)})`)
  }
  return parts.join(' ')
}

/** `CREATE TABLE` for one table. */
export function createTableSql(table: AnyTable): string {
  const cols = Object.keys(table.columns).map((k) => `  ${columnSql(table, k)}`)
  return `create table ${quote(table.name)} (\n${cols.join(',\n')}\n);`
}

/**
 * `CREATE TABLE` statements for a schema, ordered so each table comes after the tables it references.
 * A starting point for the first migration; later changes are written by hand.
 */
export function schemaSql(tables: readonly AnyTable[]): string {
  const byName = new Map(tables.map((t) => [t.name, t]))
  if (byName.size !== tables.length) throw new SchemaError('two tables have the same name.')
  const done = new Set<string>()
  const visiting = new Set<string>()
  const out: string[] = []
  const visit = (t: AnyTable) => {
    if (done.has(t.name)) return
    if (visiting.has(t.name)) throw new SchemaError(`tables reference each other in a cycle through "${t.name}"; create them first and add the foreign keys with ALTER TABLE.`)
    visiting.add(t.name)
    for (const def of Object.values(t.columns) as ColumnDef[]) {
      if (!def.references) continue
      const target = def.references()
      const known = byName.get(target.name)
      if (!known) throw new SchemaError(`table "${t.name}" references "${target.name}", which is not in the list.`)
      if (known !== t) visit(known)
    }
    visiting.delete(t.name)
    done.add(t.name)
    out.push(createTableSql(t))
  }
  for (const t of tables) visit(t)
  return out.join('\n\n') + '\n'
}

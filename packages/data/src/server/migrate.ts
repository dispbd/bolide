import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What the runner needs from a Postgres client. postgres.js clients fit as they are. */
export interface SqlClient {
  unsafe(query: string, params?: unknown[]): PromiseLike<readonly Record<string, unknown>[]>
  begin<T>(fn: (tx: SqlClient) => Promise<T>): PromiseLike<T>
}

export interface Migration {
  /** Sorts the migrations; `0001_create_todos.sql` gives `0001_create_todos`. */
  name: string
  sql: string
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

export class MigrationError extends Error {
  override name = 'MigrationError'
}

const file = /^(\d+)_[a-z0-9_]+\.sql$/
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16)

/** Reads `NNNN_name.sql` files from a folder, in order. Other files are an error, so a typo doesn't skip a migration. */
export async function readMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith('.')).sort()
  const bad = names.filter((n) => !file.test(n))
  if (bad.length) throw new MigrationError(`${dir}: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not named like 0001_create_todos.sql.`)
  const numbers = new Set<string>()
  for (const n of names) {
    const num = file.exec(n)![1]!
    if (numbers.has(num)) throw new MigrationError(`${dir}: two migrations are numbered ${num}.`)
    numbers.add(num)
  }
  return Promise.all(names.map(async (n) => ({ name: n.slice(0, -4), sql: await readFile(join(dir, n), 'utf8') })))
}

/**
 * Applies the migrations that haven't run, in name order, all in one transaction: either every pending
 * migration is applied or none is. (So statements that can't run in a transaction, such as
 * `CREATE INDEX CONCURRENTLY`, don't belong here.) A lock keeps two app instances from migrating at once.
 * A migration that changed after it ran is an error: write a new one instead.
 */
export async function migrate(sql: SqlClient, migrations: readonly Migration[], options: { table?: string } = {}): Promise<MigrateResult> {
  const table = options.table ?? 'bolide_migrations'
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new MigrationError(`migration table must be a plain identifier, got "${table}".`)
  const sorted = [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1))
  return sql.begin(async (tx) => {
    // Held until this transaction ends; other instances wait here, then find the work done.
    await tx.unsafe(`select pg_advisory_xact_lock(hashtext($1))`, [`bolide:migrate:${table}`])
    await tx.unsafe(`create table if not exists ${table} (name text primary key, checksum text not null, applied_at timestamptz not null default now())`)
    const done = new Map((await tx.unsafe(`select name, checksum from ${table}`)).map((r) => [String(r.name), String(r.checksum)]))
    const result: MigrateResult = { applied: [], skipped: [] }
    for (const m of sorted) {
      const sum = checksum(m.sql)
      const before = done.get(m.name)
      if (before !== undefined) {
        if (before !== sum) throw new MigrationError(`migration ${m.name} changed after it was applied. Revert the edit and add a new migration.`)
        result.skipped.push(m.name)
        continue
      }
      try {
        await tx.unsafe(m.sql)
      } catch (e) {
        throw new MigrationError(`migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}. Nothing from this run was applied.`)
      }
      await tx.unsafe(`insert into ${table} (name, checksum) values ($1, $2)`, [m.name, sum])
      result.applied.push(m.name)
    }
    return result
  })
}

import type { Sql, TransactionSql } from 'postgres'
import type { MutatorTx, Row } from '../core/mutator.ts'

/** Server-side tx: the same MutatorTx interface, backed by a Postgres transaction. */
export function createPgTx(sql: TransactionSql, tables: ReadonlySet<string>): MutatorTx {
  const t = (table: string) => {
    if (!tables.has(table)) throw new Error(`unknown table ${table}`)
    return sql(table)
  }
  return {
    side: 'server',
    async get<T extends Row = Row>(table: string, id: string) {
      const [row] = await sql`select * from ${t(table)} where id = ${id} for update`
      return row as T | undefined
    },
    async insert(table, row) {
      await sql`insert into ${t(table)} ${sql(row as Record<string, any>)}`
    },
    async update(table, id, patch) {
      await sql`update ${t(table)} set ${sql(patch as Record<string, any>)} where id = ${id}`
    },
    async delete(table, id) {
      await sql`delete from ${t(table)} where id = ${id}`
    },
  }
}

/** Runs fn in a transaction and returns its Postgres txid, which Electric reports back to clients. */
export async function inTransaction(sql: Sql, fn: (tx: TransactionSql) => Promise<void>): Promise<number> {
  return sql.begin(async (tx) => {
    await fn(tx)
    const [{ txid }] = await tx`select pg_current_xact_id()::xid::text as txid`
    return Number(txid)
  }) as Promise<number>
}

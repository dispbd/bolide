import { BolideError } from '@bolide/core'
import type { QueueDriver } from './driver.ts'

/** The one method the driver needs. postgres.js clients have it (`sql.unsafe`); wrap other clients to match. */
export interface SqlClient {
  unsafe(query: string, params?: unknown[]): PromiseLike<readonly Record<string, unknown>[]>
}

/**
 * A durable queue in a Postgres table. Several workers share it safely:
 * messages are claimed with `FOR UPDATE SKIP LOCKED`, and idempotency keys are a unique index.
 * The table is created on start (`setup`) if missing.
 */
export function postgresQueue(sql: SqlClient, options: { table?: string } = {}): QueueDriver {
  const table = options.table ?? 'bolide_jobs'
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(table)) throw new BolideError(`postgresQueue table must be a plain identifier like "bolide_jobs", got "${table}".`)
  const index = table.replace('.', '_')
  return {
    async setup() {
      await sql.unsafe(`
        create table if not exists ${table} (
          id bigserial primary key,
          job text not null,
          payload jsonb not null,
          status text not null default 'pending',
          attempts int not null default 0,
          max_attempts int not null,
          run_at timestamptz not null,
          locked_until timestamptz,
          key text,
          error text,
          created_at timestamptz not null default now(),
          finished_at timestamptz
        )`)
      await sql.unsafe(`create unique index if not exists ${index}_key on ${table} (key) where key is not null`)
      await sql.unsafe(`create index if not exists ${index}_due on ${table} (run_at) where status in ('pending', 'running')`)
    },
    async push(m) {
      // text::jsonb: the payload is already JSON; a bare ::jsonb param would be encoded a second time.
      const rows = await sql.unsafe(
        `insert into ${table} (job, payload, max_attempts, run_at, key) values ($1, $2::text::jsonb, $3, $4, $5)
         on conflict (key) where key is not null do nothing returning id`,
        [m.job, m.payload, m.maxAttempts, m.runAt.toISOString(), m.key ?? null],
      )
      return rows[0] ? String(rows[0].id) : undefined
    },
    async reserve(jobs, lease) {
      const rows = await sql.unsafe(
        `update ${table} set status = 'running', attempts = attempts + 1, locked_until = now() + $2 * interval '1 millisecond'
         where id = (
           select id from ${table}
           where job = any($1::text[]) and status in ('pending', 'running') and run_at <= now()
             and (locked_until is null or locked_until <= now())
           order by run_at, id limit 1
           for update skip locked
         )
         returning id, job, payload::text as payload, attempts, max_attempts`,
        [jobs, lease],
      )
      const r = rows[0]
      if (!r) return undefined
      return { id: String(r.id), job: String(r.job), payload: String(r.payload), attempt: Number(r.attempts), maxAttempts: Number(r.max_attempts) }
    },
    async complete(id) {
      await sql.unsafe(`update ${table} set status = 'done', finished_at = now(), locked_until = null, error = null where id = $1`, [id])
    },
    async retry(id, runAt, error) {
      await sql.unsafe(`update ${table} set status = 'pending', run_at = $2, locked_until = null, error = $3 where id = $1`, [id, runAt.toISOString(), error])
    },
    async fail(id, error) {
      await sql.unsafe(`update ${table} set status = 'dead', finished_at = now(), locked_until = null, error = $2 where id = $1`, [id, error])
    },
    async prune(before) {
      await sql.unsafe(`delete from ${table} where status = 'done' and finished_at < $1`, [before.toISOString()])
    },
  }
}

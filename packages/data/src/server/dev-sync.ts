import type { AnyTable } from '../table.ts'
import type { SqlClient } from './migrate.ts'
import type { SyncSource, WhereSql } from './shapes.ts'

const q = (id: string) => `"${id}"`
const CHANNEL = 'bolide_changes'
const PAGE = 1000

/**
 * SQL that records every change to `tables` in `bolide_changes` and notifies listeners: what `postgresSync()` reads.
 * Writers to these tables take a shared lock for the rest of their transaction, so change ids follow commit order;
 * that serialises writes, which is fine for development and tests and is why production uses Electric.
 */
export function devSyncSql(tables: readonly (AnyTable | string)[]): string {
  const triggers = tables.map((t) => {
    const name = q(typeof t === 'string' ? t : t.name)
    return `drop trigger if exists bolide_changes on ${name};
create trigger bolide_changes after insert or update or delete on ${name} for each row execute function bolide_record_change();`
  })
  return `create table if not exists bolide_changes (
  id bigserial primary key,
  table_name text not null,
  new jsonb,
  old jsonb,
  txid text not null,
  at timestamptz not null default now()
);
create index if not exists bolide_changes_table on bolide_changes (table_name, id);
create or replace function bolide_record_change() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('bolide_changes'));
  insert into bolide_changes (table_name, new, old, txid) values (
    tg_table_name,
    case when tg_op <> 'DELETE' then to_jsonb(new) end,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    pg_current_xact_id()::xid::text
  );
  perform pg_notify('${CHANNEL}', tg_table_name);
  return null;
end $$;
${triggers.join('\n')}
`
}

/** A postgres.js client: `listen` is used to wake long-polls when a change is recorded. */
export interface ListeningSqlClient extends SqlClient {
  listen(channel: string, onNotify: (payload: string) => void): PromiseLike<unknown>
}

export interface PostgresSyncOptions {
  /** How long a live request waits for a change before it answers "still up to date". Default 20s. */
  longPoll?: number
  /** Recorded changes older than this are deleted; clients further behind start over. Default 1 day, in ms. */
  keep?: number
  /** Install the change log and a table's trigger the first time one of its shapes is asked for. Default true. */
  install?: boolean
}

type ChangeRow = { id: string; txid: string; new: Record<string, unknown> | null; old: Record<string, unknown> | null; new_in: boolean; old_in: boolean }

/**
 * A sync source for development and tests that needs only Postgres: it speaks Electric's shape protocol from
 * the `bolide_changes` log that `devSyncSql()` sets up, so the browser uses `electricTransport()` either way.
 */
export function postgresSync(sql: ListeningSqlClient, options: PostgresSyncOptions = {}): SyncSource {
  const longPoll = options.longPoll ?? 20_000
  const keep = options.keep ?? 86_400_000
  const waiters = new Map<string, Set<() => void>>()
  let listening: PromiseLike<unknown> | undefined
  const listen = () =>
    (listening ??= sql.listen(CHANNEL, (table) => {
      for (const wake of waiters.get(table) ?? []) wake()
    }))
  let lastPrune = 0
  const installed = new Map<string, Promise<unknown>>()
  // Concurrent first requests share one install; the SQL is idempotent anyway.
  const install = (table: string) => {
    if (options.install === false) return
    let p = installed.get(table)
    if (!p) {
      p = Promise.resolve(sql.begin(async (tx) => tx.unsafe(devSyncSql([table])))).catch((e: unknown) => {
        installed.delete(table)
        throw e
      })
      installed.set(table, p)
    }
    return p
  }

  const project = (row: Record<string, unknown>, columns: string[]) => Object.fromEntries(columns.map((c) => [c, row[c]]))
  const message = (table: string, op: 'insert' | 'update' | 'delete', value: Record<string, unknown>, txid?: string) => ({
    key: `${q(table)}/${String(value[Object.keys(value)[0]!])}`,
    value,
    headers: { operation: op, ...(txid ? { txids: [Number(txid)] } : {}) },
  })

  async function changesAfter(table: string, where: WhereSql, offset: number): Promise<ChangeRow[]> {
    const cond = where.sql || 'true'
    const n = where.params.length
    const matches = (col: string) => `(c.${col} is not null and exists (select 1 from jsonb_populate_record(null::${q(table)}, c.${col}) where ${cond}))`
    return (await sql.unsafe(
      `select c.id::text as id, c.txid, c.new, c.old, ${matches('new')} as new_in, ${matches('old')} as old_in
       from bolide_changes c where c.table_name = $${n + 1} and c.id > $${n + 2} order by c.id limit ${PAGE}`,
      [...where.params, table, offset],
    )) as unknown as ChangeRow[]
  }

  /** Starts listening for a change to `table` now; `promise` settles on one, on timeout or on abort. */
  function waiter(table: string, signal: AbortSignal) {
    let done!: () => void
    const promise = new Promise<void>((resolve) => {
      const set = waiters.get(table) ?? new Set()
      waiters.set(table, set)
      done = () => {
        clearTimeout(timer)
        set.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, longPoll)
      set.add(done)
      signal.addEventListener('abort', done)
    })
    return { promise, cancel: () => done() }
  }

  return {
    async fetchShape({ table, columns, where, protocol, signal }) {
      await install(table)
      await listen()
      const handle = `dev-${hash(`${table}|${columns.join(',')}|${where.sql}|${where.params.join('\u0000')}`)}`
      const json = (body: unknown, headers: Record<string, string>, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'electric-handle': handle, ...headers } })
      const offsetParam = protocol.get('offset') ?? '-1'
      const live = protocol.get('live') === 'true'
      // A different handle means the shape (or its rule for this user) changed: start over.
      if (offsetParam !== '-1' && protocol.get('handle') !== handle) return json([{ headers: { control: 'must-refetch' } }], {}, 409)

      if (offsetParam === '-1') {
        if (Date.now() - lastPrune > 60_000) {
          lastPrune = Date.now()
          await sql.unsafe(`delete from bolide_changes where at < now() - make_interval(secs => $1)`, [keep / 1000])
        }
        const { rows, last } = await sql.begin(async (tx) => {
          await tx.unsafe('set transaction isolation level repeatable read')
          const [{ last }] = (await tx.unsafe(`select coalesce(max(id), 0)::text as last from bolide_changes`)) as [{ last: string }]
          const rows = await tx.unsafe(`select to_jsonb(t) as row from ${q(table)} t${where.sql ? ` where ${where.sql}` : ''}`, where.params)
          return { rows, last }
        })
        const body = [...rows.map((r) => message(table, 'insert', project(r.row as Record<string, unknown>, columns))), { headers: { control: 'up-to-date' } }]
        return json(body, { 'electric-offset': `${last}_0`, 'electric-schema': '{}', 'electric-up-to-date': '' })
      }

      const offset = Number(offsetParam.split('_')[0])
      if (!Number.isSafeInteger(offset) || offset < 0) return json({ message: `bad offset "${offsetParam}"` }, {}, 400)
      const [{ first, seq }] = (await sql.unsafe(`select (select min(id) from bolide_changes)::text as first, (select last_value from bolide_changes_id_seq)::text as seq`)) as [{ first: string | null; seq: string }]
      // Changes after this client's offset were pruned: it must load the shape again.
      if (offset < Number(seq) - 1 && (first === null ? offset < Number(seq) : offset < Number(first) - 1)) return json([{ headers: { control: 'must-refetch' } }], {}, 409)

      // Listen before reading, so a change committed between the read and the wait still wakes this request.
      const woken = live ? waiter(table, signal) : undefined
      let changes = await changesAfter(table, where, offset)
      if (!changes.length && woken) {
        await woken.promise
        if (!signal.aborted) changes = await changesAfter(table, where, offset)
      }
      woken?.cancel()
      const messages: unknown[] = []
      for (const c of changes) {
        if (c.new_in) messages.push(message(table, c.old_in ? 'update' : 'insert', project(c.new!, columns), c.txid))
        else if (c.old_in) messages.push(message(table, 'delete', project(c.old!, columns), c.txid))
      }
      const next = changes.length ? Number(changes[changes.length - 1]!.id) : offset
      // A full page means more is waiting: no up-to-date yet, so the client asks again at once.
      const caughtUp = changes.length < PAGE
      if (caughtUp) messages.push({ headers: { control: 'up-to-date' } })
      return json(messages, {
        'electric-offset': `${next}_0`,
        ...(caughtUp ? { 'electric-up-to-date': '' } : {}),
        ...(live ? { 'electric-cursor': String(Date.now()) } : { 'electric-schema': '{}' }),
      })
    },
  }
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

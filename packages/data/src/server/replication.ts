import type { SqlClient } from './migrate.ts'
import { decodePgOutput, formatLsn, parseLsn, type Relation, type TextRow } from './pgoutput.ts'
import type { SyncSource, WhereSql } from './shapes.ts'
import { hash, mustRefetch, PAGE, project, q, shapeMessage, shapeResponse, upToDate, waiter } from './sync-protocol.ts'

export interface ReplicationSyncOptions {
  /** The database URL for the replication connection (the `postgres` package opens it). */
  url: string
  /**
   * The replication slot. It survives restarts, so the app picks up where it stopped. Each running instance of
   * the app needs its own: `bolide_${hostname}`, for instance. Default `bolide`.
   */
  slot?: string
  /** The publication with the synced tables. Default `bolide`. */
  publication?: string
  /** Create the publication, add the tables and set REPLICA IDENTITY FULL at start. Default true; see `replicationSql()`. */
  install?: boolean
  /** Changes are kept in memory this long; a client further behind loads its shape again. Default 10 minutes, in ms. */
  keep?: number
  /** At most this many changes per table are kept. Default 100 000. */
  maxChanges?: number
  /** How long a live request waits for a change before it answers "still up to date". Default 20s. */
  longPoll?: number
  /**
   * Where trouble with the replication connection is reported: the first failure of each reconnect series, a
   * message it couldn't read, and the recovery. Default `console.warn`.
   */
  log?: (message: string, error?: unknown) => void
}

/**
 * SQL that prepares `tables` for `replicationSync()`: full old rows in the WAL (so an update that moves a row
 * out of a shape is seen) and a publication. Idempotent; put it in a migration when the app's database user
 * may not change tables, and pass `install: false`.
 */
export function replicationSql(tables: readonly string[], publication = 'bolide'): string {
  const lit = (s: string) => `'${s.replaceAll("'", "''")}'`
  return [
    `do $$ begin
  if not exists (select 1 from pg_publication where pubname = ${lit(publication)}) then create publication ${q(publication)}; end if;
end $$;`,
    ...tables.map(
      (t) => `alter table ${q(t)} replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_rel r join pg_publication p on p.oid = r.prpubid where p.pubname = ${lit(publication)} and r.prrelid = ${lit(q(t))}::regclass) then
    alter publication ${q(publication)} add table ${q(t)};
  end if;
end $$;`,
    ),
  ].join('\n')
}

/** A place in the change stream: the commit LSN of a transaction and the index of a change in it. */
type Pos = readonly [lsn: bigint, i: number]
/** "Everything of the transactions up to `lsn`". */
const LAST = 2 ** 31 - 1
const after = (a: Pos, b: Pos) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
const offsetOf = (p: Pos) => `${p[0]}_${p[1]}`
function parseOffset(s: string): Pos | undefined {
  const m = /^(\d+)_(\d+)$/.exec(s)
  return m ? [BigInt(m[1]!), Number(m[2])] : undefined
}

type Value = string | null | unknown
interface Change {
  pos: Pos
  xid: number
  op: 'insert' | 'update' | 'delete' | 'truncate'
  new?: Record<string, Value>
  old?: Record<string, Value>
  at: number
}
interface TableLog {
  /** `"schema"."table"`, for casts. */
  sqlName: string
  changes: Change[]
  /** Every change after this is in `changes`. */
  floor: Pos
  waiters: Set<() => void>
}

const JSON_TYPES = new Set([114, 3802])
const ident = /^[a-z_][a-z0-9_]*$/

/**
 * A sync source that needs only Postgres (with `wal_level=logical`) and doesn't slow writers down: it reads the
 * write-ahead log through logical replication, keeps recent changes in memory and speaks Electric's shape
 * protocol, so the browser uses `electricTransport()` as with Electric.
 *
 * Offsets are positions in the WAL, so they stay valid across restarts and between instances of the app.
 */
export function replicationSync(sql: SqlClient, options: ReplicationSyncOptions): SyncSource {
  const slot = options.slot ?? 'bolide'
  const publication = options.publication ?? 'bolide'
  for (const [what, name] of [
    ['slot', slot],
    ['publication', publication],
  ] as const)
    if (!ident.test(name)) throw new TypeError(`replicationSync: the ${what} name "${name}" must be lowercase letters, digits and _.`)
  const keep = options.keep ?? 600_000
  const maxChanges = options.maxChanges ?? 100_000
  const longPoll = options.longPoll ?? 20_000
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(`[bolide] ${message}`, ...(error === undefined ? [] : [error])))

  const logs = new Map<number, TableLog>() // by relation oid
  const byName = new Map<string, number>()
  const relations = new Map<number, Relation>()
  /** The last transaction in the logs (or the slot's start): every change up to it has arrived. */
  let head: bigint = 0n
  /** The server's position from keepalives, for acknowledging when there is nothing to keep. */
  let seen: bigint = 0n
  let systemId = ''
  let tx: { lsn: bigint; xid: number; changes: { relation: number; change: Change }[] } | undefined

  let started: Promise<void> | undefined
  let closed = false
  let replication: { end(o?: { timeout?: number }): Promise<void> } | undefined
  let stream: { write(b: Uint8Array): boolean; end(): void; destroy(): void; on(e: string, f: (...a: any[]) => void): void } | undefined
  let ticker: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let connecting: Promise<void> | undefined
  /** Set while reconnecting, so a series of failures is reported once. */
  let failing = false
  /** The delay before the next reconnect; it grows while reconnects don't lead to a transaction read. */
  let backoff = 1000
  /** Counts a connection that stays up for a while as recovered, for a database with no writes. */
  let steady: ReturnType<typeof setTimeout> | undefined
  const trackedTables = new Set<string>()

  // ---- the stream ----

  function onData(buf: Uint8Array) {
    if (buf[0] === 0x6b /* k: keepalive */) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const end = view.getBigUint64(1)
      if (end > seen) seen = end
      if (buf[17]) acknowledge()
      return
    }
    if (buf[0] !== 0x77 /* w: data */) return
    const m = decodePgOutput(buf.subarray(25), (id) => relations.get(id)?.columns)
    switch (m.tag) {
      case 'begin':
        tx = { lsn: m.lsn, xid: m.xid, changes: [] }
        return
      case 'relation':
        relations.set(m.relation.id, m.relation)
        return
      case 'insert':
      case 'update':
      case 'delete': {
        if (!tx || !logs.has(m.relation)) return
        const rel = relations.get(m.relation)!
        const change: Change = { pos: [tx.lsn, tx.changes.length], xid: tx.xid, op: m.tag, at: Date.now() }
        if (m.tag !== 'delete') change.new = values(rel, m.new)
        if (m.tag !== 'insert' && m.old) change.old = values(rel, m.old)
        tx.changes.push({ relation: m.relation, change })
        return
      }
      case 'truncate':
        if (!tx) return
        for (const r of m.relations) if (logs.has(r)) tx.changes.push({ relation: r, change: { pos: [tx.lsn, tx.changes.length], xid: tx.xid, op: 'truncate', at: Date.now() } })
        return
      case 'commit': {
        const t = tx
        tx = undefined
        if (m.end > seen) seen = m.end
        // After a reconnect the server may send again what is already here.
        if (!t || t.lsn <= head) return
        recovered()
        head = t.lsn
        const touched = new Set<TableLog>()
        for (const { relation, change } of t.changes) {
          const log = logs.get(relation)!
          log.changes.push(change)
          touched.add(log)
        }
        for (const log of touched) {
          prune(log)
          for (const wake of [...log.waiters]) wake()
        }
        return
      }
    }
  }

  /** Text values from the WAL; json columns are parsed, so `jsonb_populate_record` stores them as json and not as a string. */
  function values(rel: Relation, row: TextRow) {
    const out: Record<string, Value> = {}
    for (const c of rel.columns) if (c.name in row) out[c.name] = JSON_TYPES.has(c.type) && row[c.name] !== null ? JSON.parse(row[c.name]!) : row[c.name]
    return out
  }

  function prune(log: TableLog) {
    const old = Date.now() - keep
    const c = log.changes
    let n = 0
    while (n < c.length && (c[n]!.at < old || c.length - n > maxChanges)) {
      // A transaction goes as a whole: an offset inside it would otherwise look resumable.
      const lsn = c[n]!.pos[0]
      while (n < c.length && c[n]!.pos[0] === lsn) n++
      log.floor = [lsn, LAST]
    }
    if (n) log.changes = c.slice(n)
  }

  /** Tells Postgres which WAL it may drop: everything before the oldest change still kept. */
  function acknowledge(replyRequested = false) {
    if (!stream) return
    let lsn = tx ? tx.lsn - 1n : seen > head ? seen : head
    for (const log of logs.values()) if (log.changes.length && log.changes[0]!.pos[0] - 1n < lsn) lsn = log.changes[0]!.pos[0] - 1n
    const msg = new Uint8Array(34)
    const view = new DataView(msg.buffer)
    msg[0] = 0x72 // r: standby status update
    view.setBigUint64(1, seen > head ? seen : head) // written
    view.setBigUint64(9, lsn) // flushed: the slot keeps what comes after
    view.setBigUint64(17, lsn) // applied
    view.setBigInt64(25, BigInt(Date.now() - Date.UTC(2000, 0, 1)) * 1000n)
    msg[33] = replyRequested ? 1 : 0 // ask for a keepalive with the server's position
    stream.write(msg)
  }

  // ---- setup ----

  async function install(tables: string[]) {
    const [{ wal_level }] = (await sql.unsafe(`show wal_level`)) as [{ wal_level: string }]
    if (wal_level !== 'logical')
      throw new Error(
        `replicationSync needs wal_level=logical, and this Postgres has ${wal_level}. Set it in postgresql.conf (or start the container with \`-c wal_level=logical\`) and restart Postgres, or use postgresSync() for development.`,
      )
    for (const table of tables) {
      const [found] = (await sql.unsafe(`select to_regclass($1) is not null as ok`, [q(table)])) as [{ ok: boolean }]
      if (!found.ok) throw new Error(`replicationSync: no table "${table}" in the database. Run the migrations first.`)
    }
    if (options.install !== false) await sql.begin(async (t) => t.unsafe(replicationSql(tables, publication)))
    for (const table of tables) {
      const [rel] = (await sql.unsafe(
        `select c.oid::int as oid, n.nspname as schema, c.relreplident as identity,
           exists (select 1 from pg_publication_rel r join pg_publication p on p.oid = r.prpubid where p.pubname = $2 and r.prrelid = c.oid) as published
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = to_regclass($1)`,
        [q(table), publication],
      )) as [{ oid: number; schema: string; identity: string; published: boolean }?]
      if (!rel) throw new Error(`replicationSync: no table "${table}" in the database. Run the migrations first.`)
      if (!rel.published || rel.identity !== 'f')
        throw new Error(`replicationSync: table "${table}" is not ready for replication. Run replicationSql(['${table}'], '${publication}') in a migration, or drop install: false.`)
      byName.set(table, rel.oid)
      if (!logs.has(rel.oid)) logs.set(rel.oid, { sqlName: `${q(rel.schema)}.${q(table)}`, changes: [], floor: [head, LAST], waiters: new Set() })
    }
  }

  async function connect(): Promise<void> {
    const postgres = await import('postgres').then(
      (m) => m.default,
      (e) => {
        throw new Error('replicationSync needs the "postgres" package for its replication connection: npm i postgres', { cause: e })
      },
    )
    const repl = postgres(options.url, { max: 1, fetch_types: false, idle_timeout: 0, max_lifetime: null, onnotice: () => {}, connection: { replication: 'database' } as Record<string, string> })
    replication = repl
    try {
      const [id] = (await repl.unsafe(`IDENTIFY_SYSTEM`)) as unknown as [{ systemid: string }]
      systemId = id.systemid
      let [state] = (await sql.unsafe(`select confirmed_flush_lsn::text as lsn, wal_status from pg_replication_slots where slot_name = $1 and database = current_database()`, [slot])) as [{ lsn: string | null; wal_status: string }?]
      if (state?.wal_status === 'lost') {
        await sql.unsafe(`select pg_drop_replication_slot($1)`, [slot])
        state = undefined
      }
      let from: bigint
      if (!state?.lsn) {
        const [created] = (await repl.unsafe(`CREATE_REPLICATION_SLOT ${slot} LOGICAL pgoutput NOEXPORT_SNAPSHOT`)) as unknown as [{ consistent_point: string }]
        from = parseLsn(created.consistent_point)
        // A new slot can't say what happened before it: every client loads its shapes again.
        for (const log of logs.values()) {
          log.changes = []
          log.floor = [from - 1n, LAST]
        }
        head = from - 1n
      } else {
        from = parseLsn(state.lsn)
        if (head === 0n) {
          head = from - 1n
          for (const log of logs.values()) log.floor = [head, LAST]
        }
        if (head + 1n > from) from = head + 1n
      }
      const s = await repl.unsafe(`START_REPLICATION SLOT ${slot} LOGICAL ${formatLsn(from)} (proto_version '1', publication_names '${publication}')`).writable()
      stream = s as unknown as typeof stream
      s.on('data', (buf: Uint8Array) => {
        try {
          onData(buf)
        } catch (e) {
          // Better to read the stream again from the last acknowledged position than to skip a change.
          if (!failing) log('replicationSync could not read a message from the replication stream; reconnecting', e)
          failing = true
          s.destroy()
        }
      })
      s.on('error', () => {})
      s.on('close', () => {
        clearTimeout(steady)
        if (stream === (s as unknown)) stream = undefined
        if (closed) return
        if (!failing) log('replicationSync lost its replication connection; reconnecting')
        failing = true
        reconnect()
      })
      // close() ran while this connected: don't leave a stream behind it.
      if (closed) {
        stream = undefined
        await endStream(s as unknown as NonNullable<typeof stream>)
        await repl.end({ timeout: 1 }).catch(() => {})
        return
      }
      // A message that can't be read ends the stream within moments; one that stays up this long works.
      clearTimeout(steady)
      steady = setTimeout(recovered, 30_000)
      steady.unref?.()
    } catch (e) {
      await repl.end({ timeout: 0 }).catch(() => {})
      throw e
    }
  }

  function reconnect() {
    void replication?.end().catch(() => {})
    replication = undefined
    clearTimeout(retry)
    const delay = backoff
    backoff = Math.min(backoff * 2, 30_000)
    retry = setTimeout(() => {
      connecting = connect()
        .catch((e) => {
          if (closed) return
          if (!failing) log('replicationSync could not reconnect; retrying', e)
          failing = true
          reconnect()
        })
        .finally(() => (connecting = undefined))
    }, delay)
  }

  /**
   * A transaction was read, or the connection stayed up: replication works again. Not as soon as the connection
   * opens, since a message that can't be read every time would otherwise reconnect every second forever.
   */
  function recovered() {
    backoff = 1000
    if (!failing) return
    failing = false
    log('replicationSync is replicating again')
  }

  /** Ends the stream, and gives up waiting for the server after a moment. */
  async function endStream(s: NonNullable<typeof stream>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      new Promise<void>((r) => (s.on('close', () => r()), s.end())),
      new Promise<void>((r) => (timer = setTimeout(() => (s.destroy(), r()), 2000))),
    ])
    clearTimeout(timer)
  }

  async function startOnce(tables: string[]) {
    await install(tables)
    for (const t of tables) trackedTables.add(t)
    // Another instance (or one that just crashed) may still hold the slot for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await connect()
        // Only saves clients a load: a failure here must not leave the stream that connect() opened behind.
        await catchUp().catch((e) => log('replicationSync could not wait for the changes sent again at start; starting anyway', e))
        break
      } catch (e) {
        const busy = /is active for PID/.test(String((e as Error)?.message))
        if (!busy || attempt >= 10) {
          if (busy) throw new Error(`replicationSync: the slot "${slot}" is used by another process. Give each instance of the app its own: replicationSync(sql, { slot: 'bolide_' + id }).`)
          throw e
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (closed) return
    ticker = setInterval(() => {
      for (const log of logs.values()) prune(log)
      acknowledge()
    }, 10_000)
    ticker.unref?.()
  }

  /**
   * Waits until the stream has read the WAL up to where it was at start. After a restart the server first
   * sends again the changes since the last acknowledged position; a first load served before they are in
   * the log would get them again afterwards (a past TRUNCATE would make every client load again).
   */
  async function catchUp() {
    const [{ lsn }] = (await sql.unsafe(`select pg_current_wal_lsn()::text as lsn`)) as [{ lsn: string }]
    const target = parseLsn(lsn)
    for (const end = Date.now() + 10_000; Date.now() < end && !closed; ) {
      // A logical walsender's keepalive carries the position it has sent up to, after the data before it.
      if (seen >= target || head >= target) return
      acknowledge(true)
      await new Promise((r) => setTimeout(r, 20))
    }
    if (!closed) log('replicationSync started before the changes sent again had all arrived; clients that load now may load once more')
  }

  /** Starts once; a start that failed (the database was down at boot) is tried again by the next caller. */
  function begin(tables: string[]) {
    if (!started) {
      started = startOnce(tables)
      started.catch(() => (started = undefined))
    }
    return started
  }

  const tracking = new Map<string, Promise<TableLog>>()
  /** The log of `table`, set up for replication the first time it is asked for. */
  function track(table: string): Promise<TableLog> {
    if (closed) return Promise.reject(new Error('replicationSync is closed'))
    let p = tracking.get(table)
    if (!p) {
      p = (async () => {
        await begin([table])
        // Marked only once installed: a failed install is tried again by the next request.
        if (!trackedTables.has(table)) {
          await install([table])
          trackedTables.add(table)
        }
        return logs.get(byName.get(table)!)!
      })()
      p.catch(() => tracking.delete(table))
      tracking.set(table, p)
    }
    return p
  }

  /** Changes of `log` after `offset`, oldest first. */
  function since(log: TableLog, offset: Pos) {
    const out: Change[] = []
    for (let i = log.changes.length - 1; i >= 0 && after(log.changes[i]!.pos, offset); i--) out.push(log.changes[i]!)
    return out.reverse()
  }

  // ---- shapes ----

  type Evaluated = { i: number; new_in: boolean; old_in: boolean; new_row: Record<string, unknown> | null; old_row: Record<string, unknown> | null }

  // Live clients of the same shape (the same user in several tabs, or a shape everyone shares) wake up together
  // with the same changes: they share one query. Entries go a few seconds after they settle.
  const evaluations = new Map<string, Promise<Evaluated[]>>()
  function evaluate(log: TableLog, where: WhereSql, changes: Change[]) {
    const key = `${log.sqlName}\0${where.sql}\0${where.params.join('\0')}\0${offsetOf(changes[0]!.pos)}\0${offsetOf(changes[changes.length - 1]!.pos)}\0${changes.length}`
    let p = evaluations.get(key)
    if (!p) {
      p = evaluateNow(log, where, changes)
      evaluations.set(key, p)
      const forget = () => setTimeout(() => evaluations.delete(key), 5000).unref?.()
      p.then(forget, () => evaluations.delete(key))
    }
    return p
  }

  /** Runs the shape's where on each change's old and new row, in Postgres, so it means exactly what the first load meant. */
  async function evaluateNow(log: TableLog, where: WhereSql, changes: Change[]) {
    const cond = where.sql || 'true'
    const n = where.params.length
    const record = (col: string) => `jsonb_populate_record(null::${log.sqlName}, x.${col})`
    const rows = (await sql.unsafe(
      `select x.i,
         (x.new is not null and exists (select 1 from ${record('new')} where ${cond})) as new_in,
         (x.old is not null and exists (select 1 from ${record('old')} where ${cond})) as old_in,
         case when x.new is not null then (select to_jsonb(r) from ${record('new')} r) end as new_row,
         case when x.old is not null then (select to_jsonb(r) from ${record('old')} r) end as old_row
       from jsonb_to_recordset($${n + 1}::text::jsonb) as x(i int, new jsonb, old jsonb) order by x.i`,
      [...where.params, JSON.stringify(changes.map((c, i) => ({ i, new: c.new ?? null, old: c.old ?? null })))],
    )) as unknown as Evaluated[]
    return rows
  }

  /** Is the transaction `xid` (32 bits, from the WAL) missing from the snapshot `xmin:xmax:xip,...`? */
  function invisible(snapshot: string, xid: number) {
    const [xmin, xmax, xip] = snapshot.split(':') as [string, string, string]
    const max = BigInt(xmax)
    // Extend the 32-bit xid to the snapshot's epoch.
    const diff = BigInt.asIntN(32, BigInt(xid) - BigInt.asUintN(32, max))
    const full = max + diff
    if (full < BigInt(xmin)) return false
    return full >= max || (xip ? xip.split(',').some((x) => BigInt(x) === full) : false)
  }

  return {
    subqueries: true,
    start: async (tables) => {
      await begin(tables)
      for (const t of tables) if (!trackedTables.has(t)) await track(t)
    },

    async close() {
      closed = true
      clearInterval(ticker)
      clearTimeout(retry)
      clearTimeout(steady)
      for (const log of logs.values()) for (const wake of [...log.waiters]) wake()
      await started?.catch(() => {})
      await connecting
      acknowledge()
      const s = stream
      stream = undefined
      if (s) await endStream(s)
      await replication?.end({ timeout: 1 }).catch(() => {})
    },

    async fetchShape({ table, columns, where, protocol, signal }) {
      const log = await track(table)
      const deps = await Promise.all((where.deps ?? []).map(async (d) => ({ log: await track(d.table), where: d.where })))
      const handle = `r-${hash(`${systemId}|${table}|${columns.join(',')}|${where.sql}|${where.params.join('\u0000')}`)}`
      const json = shapeResponse(handle)
      const offsetParam = protocol.get('offset') ?? '-1'
      const live = protocol.get('live') === 'true'

      if (offsetParam === '-1') {
        let pos: Pos = [head, LAST]
        const { rows, snapshot } = await sql.begin(async (t) => {
          await t.unsafe('set transaction isolation level repeatable read')
          const [{ snapshot }] = (await t.unsafe(`select pg_current_snapshot()::text as snapshot`)) as [{ snapshot: string }]
          const rows = await t.unsafe(`select to_jsonb(t) as row from ${log.sqlName} t${where.sql ? ` where ${where.sql}` : ''}`, where.params)
          return { rows, snapshot }
        })
        // A transaction already in the log but not in the snapshot (it committed while the snapshot was taken)
        // must still reach this client: start before it. Later ones in the log are sent again, which is harmless.
        // (For a table the rule reads, a change sent again means one more load, which is rare and also harmless.)
        // Oldest first, one check per transaction, up to the first invisible one. The scan can't stop early at a
        // visible one: a transaction becomes visible when it leaves the proc array, not in commit record order,
        // so an older commit can still be in progress (synchronous_commit waiting on a standby, for instance).
        const start = pos
        for (const l of [log, ...deps.map((d) => d.log)]) {
          let lsn = -1n
          for (const c of l.changes) {
            if (after(c.pos, start)) break
            if (c.pos[0] === lsn) continue
            lsn = c.pos[0]
            if (invisible(snapshot, c.xid)) {
              if (after(pos, [lsn - 1n, LAST])) pos = [lsn - 1n, LAST]
              break
            }
          }
        }
        const body = [...rows.map((r) => shapeMessage(table, 'insert', project(r.row as Record<string, unknown>, columns))), upToDate]
        return json(body, { 'electric-offset': offsetOfSafe(pos), 'electric-schema': '{}', 'electric-up-to-date': '' })
      }

      if (protocol.get('handle') !== handle) return json(mustRefetch, {}, 409)
      const offset = parseOffset(offsetParam)
      if (!offset) return json({ message: `bad offset "${offsetParam}"` }, {}, 400)
      // Older than what is kept (or from before a lost slot): start over.
      if ([log, ...deps.map((d) => d.log)].some((l) => after(l.floor, offset))) return json(mustRefetch, {}, 409)

      // Everything up to `top` is read at the same moment, so the offset given back covers exactly what was checked.
      const read = () => ({ top: [head, LAST] as Pos, changes: since(log, offset), depChanges: deps.map((d) => since(d.log, offset)) })
      const woken = live ? waiter([log.waiters, ...deps.map((d) => d.log.waiters)], signal, longPoll) : undefined
      let { top, changes, depChanges } = read()
      if (!changes.length && !depChanges.some((c) => c.length) && woken) {
        await woken.promise
        if (!signal.aborted) ({ top, changes, depChanges } = read())
      }
      woken?.cancel()
      if (changes.some((c) => c.op === 'truncate')) return json(mustRefetch, {}, 409)
      // A row that a query(...) of the rule reads changed in a way that matters: the shape's rows may differ now.
      for (const [k, dc] of depChanges.entries()) {
        if (!dc.length) continue
        if (dc.some((c) => c.op === 'truncate')) return json(mustRefetch, {}, 409)
        for (let i = 0; i < dc.length; i += PAGE) {
          const evaluated = await evaluate(deps[k]!.log, deps[k]!.where, dc.slice(i, i + PAGE))
          if (evaluated.some((e) => e.new_in || e.old_in)) return json(mustRefetch, {}, 409)
        }
      }

      const page = changes.slice(0, PAGE)
      const messages: unknown[] = []
      if (page.length) {
        const evaluated = await evaluate(log, where, page)
        for (const e of evaluated) {
          const c = page[e.i]!
          const oldIn = c.op === 'update' && !c.old ? true : e.old_in
          if (e.new_in) messages.push(shapeMessage(table, c.op === 'update' && oldIn ? 'update' : 'insert', project(e.new_row!, columns), c.xid))
          else if (oldIn && (c.old || c.new)) messages.push(shapeMessage(table, 'delete', project((e.old_row ?? e.new_row)!, columns), c.xid))
        }
      }
      const caughtUp = changes.length <= PAGE
      // Caught up: the client is at the head, so a quiet table never falls behind what is kept.
      let next: Pos = page.length ? page[page.length - 1]!.pos : offset
      if (caughtUp && after(top, next)) next = top
      if (caughtUp) messages.push(upToDate)
      return json(messages, {
        'electric-offset': offsetOfSafe(next),
        ...(caughtUp ? { 'electric-up-to-date': '' } : {}),
        ...(live ? { 'electric-cursor': String(Date.now()) } : { 'electric-schema': '{}' }),
      })
    },
  }

  function offsetOfSafe(p: Pos) {
    return offsetOf(p[0] < 0n ? [0n, LAST] : p)
  }
}

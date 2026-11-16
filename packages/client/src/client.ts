import {
  checkInput,
  checkInsert,
  checkPatch,
  fromSqlRow,
  MutatorError,
  normalizeRow,
  withDefaults,
  type AnyMutator,
  type AnyShape,
  type AnyTable,
  type MutatorInput,
  type MutatorTx,
  type ShapeRow,
} from '@bolide/data'
import type { ClientStorage } from './storage.ts'
import type { SyncChange, SyncPosition, SyncTransport } from './transport.ts'
import { matches } from './where.ts'

type Rows = Map<string, Record<string, unknown>>

/** The server refused a mutation. Its optimistic change has been rolled back. */
export class MutationRejected extends Error {
  override name = 'MutationRejected'
  constructor(
    message: string,
    readonly status: number,
    /** The `MutatorError` code (`forbidden`, `not_found`...), or another error code from the server. */
    readonly code: string,
  ) {
    super(message)
  }
}

export type MutationStatus = 'pending' | 'sent' | 'confirmed' | 'rejected'

export interface Mutation {
  readonly id: string
  readonly name: string
  readonly status: MutationStatus
  /** Settles once the change is in the local store (or was refused before it got there). */
  readonly applied: Promise<void>
  /** Settles once the server has applied it and it has synced back; rejects with `MutationRejected`. */
  readonly done: Promise<void>
}

export type ShapeStatus = 'loading' | 'ready' | 'error'

export interface ShapeView<R> {
  /** The rows now: synced ones with pending changes applied. The same array until something changes. */
  rows(): readonly R[]
  readonly status: ShapeStatus
  /** Called after every change to `rows()` or `status`. Returns a function that unsubscribes. */
  subscribe(listener: () => void): () => void
  /** Resolves when the first full set of rows has arrived. */
  readonly ready: Promise<void>
}

export interface ClientOptions {
  /** Base of the data routes. Default `/api/data`. */
  url?: string
  transport: SyncTransport
  /** The mutators this client may call. */
  mutators: readonly AnyMutator[]
  /**
   * The signed-in user's id, for optimistic runs and for deciding which optimistic rows a shape shows.
   * The server never trusts it; it uses the session.
   */
  userId?: () => string | undefined
  /** Extra headers for every request (a bearer token, for instance). Cookies are sent anyway. */
  headers?: () => Record<string, string>
  fetch?: typeof fetch
  /** How long to wait for a confirmed change to sync back before the optimistic copy is dropped anyway. Default 10s. */
  confirmTimeout?: number
  /** Backoff for retries while the server can't be reached. Default 500ms doubling to 30s. */
  retry?: { initial?: number; max?: number }
  /** Called for every rejected mutation, also the ones nobody awaits. */
  onRejected?: (mutation: Mutation, error: MutationRejected) => void
  /**
   * Keeps synced rows and unsent mutations across reloads (offline mode): `indexedDbStorage()` from
   * `@bolide/client/idb` in the browser. Saved data is kept per user id: when the user changes, create a new
   * client (this one stops saving), and call `clearStorage()` on sign-out.
   */
  storage?: ClientStorage
  /** Called when the storage fails; the client keeps working from memory. Default: `console.warn`. */
  onStorageError?: (error: unknown) => void
}

/** The client as a whole: whether the server answers, and how many changes it hasn't confirmed yet. */
export interface ClientStatus {
  readonly online: boolean
  readonly pending: number
}

interface SavedShape {
  columns: string[]
  rows: Record<string, unknown>[]
  position: SyncPosition
}

interface SavedMutation {
  id: string
  name: string
  input: unknown
}

interface PendingMutation {
  id: string
  mutator: AnyMutator
  input: unknown
  /** Writes from the latest local run, replayed over the synced rows. */
  ops: Op[]
  status: MutationStatus
  handle: Mutation
  settle: { resolve: () => void; reject: (e: MutationRejected) => void }
  /** Orders saved mutations: when it was made, then a counter. */
  savedAt: string
}

type Op = { table: AnyTable; type: 'put'; key: string; row: Record<string, unknown> } | { table: AnyTable; type: 'delete'; key: string }

interface ShapeState {
  shape: AnyShape
  rows: Rows
  status: ShapeStatus
  listeners: Set<() => void>
  view: readonly Record<string, unknown>[]
  stop?: () => void
  /** Restoring saved rows before the stream starts. */
  starting?: boolean
  ready: Promise<void>
  markReady: () => void
  saveTimer?: ReturnType<typeof setTimeout>
  position?: SyncPosition
}

const closedError = () => new MutationRejected('the client was closed before the server confirmed this change', 0, 'closed')

const keyOf = (table: AnyTable, row: Record<string, unknown>) => String(row[table.primaryKey])

/**
 * The browser side of the data layer: a local store kept in sync with shapes, and a queue of mutations that
 * show at once and are confirmed or rolled back by the server.
 */
export function createClient(options: ClientOptions) {
  const base = (options.url ?? '/api/data').replace(/\/$/, '')
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const userId = options.userId ?? (() => undefined)
  const headers = options.headers ?? (() => ({}))
  const confirmTimeout = options.confirmTimeout ?? 10_000
  const retryInitial = options.retry?.initial ?? 500
  const retryMax = options.retry?.max ?? 30_000
  const mutators = new Map<string, AnyMutator>()
  for (const m of options.mutators) {
    if (mutators.has(m.name) && mutators.get(m.name) !== m) throw new TypeError(`createClient: two mutators are named "${m.name}".`)
    mutators.set(m.name, m)
  }

  const shapes = new Map<string, ShapeState>()
  const pending: PendingMutation[] = []
  /** Table name → rows as the UI sees them: synced rows of every active shape, then pending writes. */
  let view = new Map<string, Rows>()
  const seenTxids = new Set<string>()
  const txidWaiters = new Map<string, () => void>()

  // ---- status and storage ----

  let status: ClientStatus = { online: true, pending: 0 }
  const statusListeners = new Set<() => void>()
  function setStatus(patch: Partial<ClientStatus>) {
    const next = { ...status, ...patch }
    if (next.online === status.online && next.pending === status.pending) return
    status = next
    for (const l of statusListeners) l()
  }
  const unconfirmed = () => pending.filter((p) => p.status === 'pending' || p.status === 'sent').length

  const storage = options.storage
  const onStorageError = options.onStorageError ?? ((e: unknown) => console.warn('bolide: client storage failed', e))
  // Saved data belongs to the user who was signed in when the client started.
  const scope = encodeURIComponent(userId() ?? '')
  const shapeKey = (name: string) => `shape:${scope}:${name}`
  const mutationPrefix = `mutation:${scope}:`
  let mutationSeq = 0
  /** Each mutation is its own entry, so tabs sharing the storage never overwrite each other's. */
  const mutationKey = (p: PendingMutation) => `${mutationPrefix}${p.savedAt}:${p.id}`
  let writes = Promise.resolve()
  let cleared = false
  /** Saves under this user's key; deletes (which only remove this user's own data) go through after a change of user too. */
  const write = (fn: (s: ClientStorage) => Promise<void>, kind: 'set' | 'delete' = 'set') => {
    // Another user signed in (or this one signed out): their data must not land under this user's key.
    if (!storage || cleared || (kind === 'set' && encodeURIComponent(userId() ?? '') !== scope)) return
    writes = writes.then(() => fn(storage)).catch(onStorageError)
  }

  // ---- local store ----

  function syncedTable(name: string): Rows {
    const out: Rows = new Map()
    for (const s of shapes.values()) if (s.shape.table.name === name) for (const [k, r] of s.rows) out.set(k, { ...out.get(k), ...r })
    return out
  }

  function tableView(v: Map<string, Rows>, table: AnyTable): Rows {
    let rows = v.get(table.name)
    if (!rows) v.set(table.name, (rows = syncedTable(table.name)))
    return rows
  }

  /** A MutatorTx over a working copy of the view; its writes are recorded as ops. */
  function localTx(v: Map<string, Rows>, ops: Op[]): MutatorTx {
    const invalid = (issues: { message: string }[]) => {
      throw new MutatorError('invalid_input', issues.map((i) => i.message).join('; '))
    }
    return {
      async get(table, id) {
        const row = tableView(v, table).get(String(id))
        return row ? (structuredClone(row) as never) : undefined
      },
      async insert(table, row) {
        const issues = checkInsert(table, row)
        if (issues.length) invalid(issues)
        const full = withDefaults(table, row as Record<string, unknown>) as Record<string, unknown>
        const key = keyOf(table, full)
        const rows = tableView(v, table)
        if (rows.has(key)) throw new MutatorError('conflict', `${table.name} ${key} already exists.`)
        rows.set(key, full)
        ops.push({ table, type: 'put', key, row: full })
        return structuredClone(full) as never
      },
      async update(table, id, patch) {
        const issues = checkPatch(table, patch)
        if (issues.length) invalid(issues)
        const rows = tableView(v, table)
        const key = String(id)
        const row = rows.get(key)
        if (!row) throw new MutatorError('not_found', `${table.name} ${key} does not exist.`)
        const next = { ...row }
        for (const [k, val] of Object.entries(patch as Record<string, unknown>)) if (val !== undefined) next[k] = val
        rows.set(key, next)
        ops.push({ table, type: 'put', key, row: next })
      },
      async delete(table, id) {
        const key = String(id)
        tableView(v, table).delete(key)
        ops.push({ table, type: 'delete', key })
      },
    }
  }

  async function runLocal(p: PendingMutation, v: Map<string, Rows>): Promise<void> {
    const ops: Op[] = []
    try {
      await p.mutator.run({ tx: localTx(v, ops), input: p.input, side: 'client', userId: userId() })
      p.ops = ops
    } catch (e) {
      // A writes-then-throws run must not leave half its writes in the working copy.
      for (const op of ops) {
        const rows = tableView(v, op.table)
        rows.delete(op.key)
        const synced = syncedTable(op.table.name).get(op.key)
        if (synced) rows.set(op.key, synced)
      }
      p.ops = []
      throw e
    }
  }

  /** Rebuilds the view from synced rows, replaying every pending mutation in order (a rebase). */
  let chain: Promise<void> = Promise.resolve()
  let rebuildQueued = false
  function rebuild(): Promise<void> {
    if (rebuildQueued) return chain
    rebuildQueued = true
    chain = chain.then(async () => {
      rebuildQueued = false
      const next = new Map<string, Rows>()
      for (const p of pending) {
        if (!p.mutator.local) continue
        // A pending change that no longer applies to the new rows (the server already has it, or it conflicts) shows nothing.
        await runLocal(p, next).catch(() => {})
      }
      view = next
      publish()
    })
    return chain
  }

  function shapeRows(s: ShapeState): readonly Record<string, unknown>[] {
    const table = s.shape.table
    const rows = view.get(table.name) ?? syncedTable(table.name)
    const touched = new Set<string>()
    for (const p of pending) for (const op of p.ops) if (op.table === table) touched.add(op.key)
    const where = touched.size ? s.shape.where({ userId: userId() }) : false
    const out: Record<string, unknown>[] = []
    const keys = new Set([...s.rows.keys(), ...touched])
    for (const k of keys) {
      const row = rows.get(k)
      if (!row) continue
      // Untouched rows are the server's answer; changed or new ones are checked against the shape's rule here.
      if (touched.has(k) && (where === false || !matches(table, row, where))) continue
      const picked: Record<string, unknown> = {}
      for (const c of s.shape.columns as string[]) picked[c] = row[c]
      out.push(picked)
    }
    return out
  }

  function publish() {
    for (const s of shapes.values()) {
      const next = shapeRows(s)
      if (!sameRows(s.view, next)) {
        s.view = next
        for (const l of s.listeners) l()
      }
    }
  }

  function applySync(s: ShapeState, changes: SyncChange[], txids: readonly string[]) {
    const table = s.shape.table
    for (const c of changes) {
      const row = normalizeRow(table, fromSqlRow(table, c.row)) as Record<string, unknown>
      const key = keyOf(table, row)
      if (c.type === 'delete') s.rows.delete(key)
      else s.rows.set(key, c.type === 'update' ? { ...s.rows.get(key), ...row } : row)
    }
    for (const t of txids) {
      seenTxids.add(t)
      txidWaiters.get(t)?.()
    }
    // Only txids that arrive before their mutation's answer matter; keep the newest few.
    if (seenTxids.size > 1000) for (const t of seenTxids) if (seenTxids.delete(t) && seenTxids.size <= 500) break
    void rebuild()
  }

  // ---- shapes ----

  function shape<S extends AnyShape>(sh: S): ShapeView<ShapeRow<S>> {
    let s = shapes.get(sh.name)
    if (s && s.shape !== sh) throw new TypeError(`two shapes are named "${sh.name}".`)
    if (!s) {
      let markReady = () => {}
      const ready = new Promise<void>((r) => (markReady = r))
      s = { shape: sh, rows: new Map(), status: 'loading', listeners: new Set(), view: [], ready, markReady }
      shapes.set(sh.name, s)
    }
    const state = s
    return {
      rows: () => state.view as readonly ShapeRow<S>[],
      get status() {
        return state.status
      },
      ready: state.ready,
      subscribe(listener) {
        state.listeners.add(listener)
        if (!state.stop && !state.starting) start(state)
        return () => {
          state.listeners.delete(listener)
          // Wait a tick: a component that remounts at once (React StrictMode, a route change) keeps the stream.
          if (!state.listeners.size)
            setTimeout(() => {
              if (state.listeners.size || !state.stop) return
              flushShapeSave(state)
              state.stop()
              state.stop = undefined
              state.rows.clear()
              state.status = 'loading'
              void rebuild()
            }, 0)
        }
      },
    }
  }

  function start(state: ShapeState) {
    const sh = state.shape
    const notify = () => {
      for (const l of state.listeners) l()
    }
    const open = (resume?: SyncPosition) =>
      options.transport.subscribe(
        { url: `${base}/shape/${encodeURIComponent(sh.name)}`, shape: sh, headers, ...(resume ? { resume } : {}) },
        {
          changes: (changes, txids) => {
            setStatus({ online: true })
            applySync(state, changes, txids)
          },
          upToDate: () => {
            setStatus({ online: true })
            if (state.status === 'ready') return
            // After the rebuild that applySync queued, so `await ready` sees the first rows.
            void rebuild().then(() => {
              if (state.status === 'ready' || !state.stop) return
              state.status = 'ready'
              state.markReady()
              notify()
            })
          },
          reset: () => {
            state.rows.clear()
            clearTimeout(state.saveTimer)
            state.saveTimer = undefined
            write((st) => st.delete(shapeKey(sh.name)), 'delete')
            void rebuild()
          },
          error: () => {
            state.status = 'error'
            notify()
          },
          position: (position) => scheduleShapeSave(state, position),
          offline: () => setStatus({ online: false }),
        },
      )
    if (!storage) {
      state.stop = open()
      return
    }
    // Show the saved rows at once, then resume the stream where they were saved.
    state.starting = true
    void (async () => {
      let resume: SyncPosition | undefined
      try {
        const saved = (await storage.get(shapeKey(sh.name))) as SavedShape | undefined
        const columns = sh.columns as string[]
        if (saved && !state.stop && saved.columns.join() === columns.join()) {
          for (const row of saved.rows) state.rows.set(keyOf(sh.table, row), row)
          resume = saved.position
          await rebuild()
          state.status = 'ready'
          state.markReady()
          notify()
        }
      } catch (e) {
        onStorageError(e)
      }
      state.starting = false
      if (closed) return
      if (!state.listeners.size) {
        state.rows.clear()
        state.status = 'loading'
        void rebuild()
        return
      }
      state.stop = open(resume)
    })()
  }

  /** Saves a shape's rows with its stream position, at most a few times a second. */
  function scheduleShapeSave(state: ShapeState, position: SyncPosition) {
    if (!storage) return
    state.position = position
    state.saveTimer ??= setTimeout(() => flushShapeSave(state), 200)
  }
  function flushShapeSave(state: ShapeState) {
    if (!state.saveTimer || !state.position) return
    clearTimeout(state.saveTimer)
    state.saveTimer = undefined
    const saved: SavedShape = { columns: [...(state.shape.columns as string[])], rows: [...state.rows.values()], position: state.position }
    write((st) => st.set(shapeKey(state.shape.name), saved))
  }

  // ---- mutations ----

  function mutate<M extends AnyMutator>(mutator: M, input: MutatorInput<M>): Mutation {
    if (mutators.get(mutator.name) !== mutator) throw new TypeError(`mutator "${mutator.name}" is not in createClient({ mutators }).`)
    const { handle, step } = enqueue(mutator, input, crypto.randomUUID(), true)
    chain = chain.then(step)
    return handle
  }

  /** A mutation and the step that applies it locally and queues it; steps run in order on `chain`. */
  function enqueue(mutator: AnyMutator, input: unknown, id: string, save: boolean) {
    let settle!: PendingMutation['settle']
    const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    done.catch(() => {}) // the caller may not await it; onRejected still hears about it
    let markApplied!: () => void
    const applied = new Promise<void>((r) => (markApplied = r))
    const savedAt = `${Date.now().toString(36).padStart(10, '0')}-${(mutationSeq++).toString(36).padStart(6, '0')}`
    const p = { id, mutator, input, ops: [], status: 'pending', settle, savedAt } as unknown as PendingMutation
    p.handle = {
      id,
      name: mutator.name,
      get status() {
        return p.status
      },
      applied,
      done,
    }
    const step = async () => {
      try {
        if (closed) throw closedError()
        p.input = await checkInput(mutator, input)
        if (closed) throw closedError()
        if (mutator.local) {
          const working = cloneView(view)
          await runLocal(p, working)
          if (closed) throw closedError()
          view = working
        }
        pending.push(p)
        if (save) {
          const saved: SavedMutation = { id, name: mutator.name, input: p.input }
          write((st) => st.set(mutationKey(p), saved))
        }
        setStatus({ pending: unconfirmed() })
        publish()
        void flush()
      } catch (e) {
        reject(p, e instanceof MutationRejected ? e : e instanceof MutatorError ? new MutationRejected(e.message, 0, e.code) : new MutationRejected(String((e as Error)?.message ?? e), 0, 'client_error'))
      } finally {
        markApplied()
      }
    }
    return { p, handle: p.handle, step }
  }

  // Unsent mutations from the last session go first, before anything this session adds.
  if (storage) {
    const loaded = storage.list(mutationPrefix).catch((e: unknown) => (onStorageError(e), [] as [string, unknown][]))
    chain = chain.then(async () => {
      for (const [key, value] of await loaded) {
        const saved = value as SavedMutation
        const mutator = mutators.get(saved.name)
        // The app no longer has this mutator: nothing can send it.
        if (!mutator) {
          write((st) => st.delete(key), 'delete')
          continue
        }
        const { p, step } = enqueue(mutator, saved.input, saved.id, false)
        p.savedAt = key.slice(mutationPrefix.length, key.length - saved.id.length - 1)
        await step()
      }
    })
  }

  function reject(p: PendingMutation, error: MutationRejected) {
    p.status = 'rejected'
    // A closed client keeps its saved mutations: the next session sends them.
    if (error.code !== 'closed') write((st) => st.delete(mutationKey(p)), 'delete')
    if (!closed) setStatus({ pending: unconfirmed() })
    p.settle.reject(error)
    options.onRejected?.(p.handle, error)
  }

  function finish(p: PendingMutation) {
    const i = pending.indexOf(p)
    if (i >= 0) pending.splice(i, 1)
    if (p.status === 'confirmed') write((st) => st.delete(mutationKey(p)), 'delete')
    setStatus({ pending: unconfirmed() })
    return rebuild()
  }

  let flushing = false
  let closed = false
  const naps = new Set<() => void>()
  /** A backoff wait that close() cuts short. */
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const wake = () => (clearTimeout(timer), naps.delete(wake), resolve())
      const timer = setTimeout(wake, ms)
      naps.add(wake)
    })
  async function flush() {
    if (flushing) return
    flushing = true
    try {
      let delay = retryInitial
      for (let p = pending.find((x) => x.status === 'pending'); p && !closed; p = pending.find((x) => x.status === 'pending')) {
        let res: Response
        try {
          res = await doFetch(`${base}/mutate`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', ...headers() },
            body: JSON.stringify({ id: p.id, name: p.mutator.name, input: p.input }),
          })
        } catch {
          setStatus({ online: false })
          await nap(delay) // offline or the server is restarting: same mutation again, in order
          delay = Math.min(delay * 2, retryMax)
          continue
        }
        setStatus({ online: true })
        if (res.status >= 500 || res.status === 429 || res.status === 408) {
          await res.body?.cancel().catch(() => {})
          await nap(delay)
          delay = Math.min(delay * 2, retryMax)
          continue
        }
        delay = retryInitial
        const body = (await res.json().catch(() => ({}))) as { txid?: string; error?: string; message?: string }
        // close() already rejected it while the request was in flight.
        if (closed) return
        if (!res.ok) {
          reject(p, new MutationRejected(body.message ?? res.statusText, res.status, body.error ?? `http_${res.status}`))
          await finish(p)
          continue
        }
        p.status = 'sent'
        // Without a txid (a proxy or a custom route answered) there is nothing to wait for on the stream.
        void confirm(p, typeof body.txid === 'string' || typeof body.txid === 'number' ? String(body.txid) : undefined)
      }
    } finally {
      flushing = false
    }
  }

  // The browser says the network is back: retry now instead of waiting out the backoff.
  const onOnline = () => {
    for (const wake of [...naps]) wake()
  }
  globalThis.addEventListener?.('online', onOnline)

  async function confirm(p: PendingMutation, txid: string | undefined) {
    const synced = new Set([...shapes.values()].filter((s) => s.stop).map((s) => s.shape.table))
    const waits = p.ops.some((op) => synced.has(op.table))
    if (txid !== undefined && waits && !seenTxids.has(txid)) {
      const id = txid
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, confirmTimeout)
        function done() {
          clearTimeout(timer)
          txidWaiters.delete(id)
          resolve()
        }
        txidWaiters.set(id, done)
      })
    }
    if (txid !== undefined) seenTxids.delete(txid)
    if (closed) return // close() already rejected it
    p.status = 'confirmed'
    await finish(p)
    p.settle.resolve()
  }

  return {
    mutate,
    shape,
    /** Mutations not yet confirmed, oldest first. */
    pending: () => pending.map((p) => p.handle) as readonly Mutation[],
    /** Whether the server answers, and how many changes wait for it. The same object until one of them changes. */
    status: () => status,
    /** Called when `status()` changes. Returns a function that unsubscribes. */
    subscribeStatus(listener: () => void) {
      statusListeners.add(listener)
      return () => void statusListeners.delete(listener)
    },
    /** Resolves when everything the client meant to save is in storage. */
    saved: async () => {
      for (const s of shapes.values()) flushShapeSave(s)
      await writes
    },
    /**
     * Deletes everything saved in the storage, for every user, and stops this client from saving more. For
     * sign-out on a shared device: then close the client and create one for the next user.
     */
    async clearStorage() {
      cleared = true
      for (const s of shapes.values()) {
        clearTimeout(s.saveTimer)
        s.saveTimer = undefined
      }
      await writes
      if (!storage) return
      for (const [key] of await storage.list('')) if (key.startsWith('shape:') || key.startsWith('mutation:')) await storage.delete(key)
    },
    /** Stops every shape stream and stops sending. Unconfirmed mutations reject with code `closed`. */
    close() {
      closed = true
      globalThis.removeEventListener?.('online', onOnline)
      for (const s of shapes.values()) flushShapeSave(s)
      // Unconfirmed mutations end here: `done` must neither hang nor claim a sync that didn't happen.
      for (const p of pending.splice(0)) {
        if (p.status === 'rejected' || p.status === 'confirmed') continue
        reject(p, closedError())
      }
      for (const wake of [...naps]) wake()
      for (const done of [...txidWaiters.values()]) done()
      for (const s of shapes.values()) {
        s.stop?.()
        s.stop = undefined
      }
      shapes.clear()
    },
  }
}

export type Client = ReturnType<typeof createClient>

function cloneView(v: Map<string, Rows>) {
  const out = new Map<string, Rows>()
  for (const [k, rows] of v) out.set(k, new Map(rows))
  return out
}

function sameRows(a: readonly Record<string, unknown>[], b: readonly Record<string, unknown>[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    for (const k of Object.keys(y)) if (x[k] !== y[k] && JSON.stringify(x[k]) !== JSON.stringify(y[k])) return false
  }
  return true
}


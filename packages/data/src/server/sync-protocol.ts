// Pieces of Electric's shape protocol shared by the Postgres-only sync sources.

export const q = (id: string) => `"${id.replaceAll('"', '""')}"`

/** Changes per response; a full page means more are waiting. */
export const PAGE = 1000

export const project = (row: Record<string, unknown>, columns: readonly string[]) => Object.fromEntries(columns.map((c) => [c, row[c]]))

/** One shape log entry. The key only has to be unique per row; the first column is the primary key. */
export const shapeMessage = (table: string, op: 'insert' | 'update' | 'delete', value: Record<string, unknown>, txid?: string | number) => ({
  key: `${q(table)}/${String(value[Object.keys(value)[0]!])}`,
  value,
  headers: { operation: op, ...(txid !== undefined ? { txids: [Number(txid)] } : {}) },
})

export const upToDate = { headers: { control: 'up-to-date' } }
export const mustRefetch = [{ headers: { control: 'must-refetch' } }]

export function shapeResponse(handle: string) {
  return (body: unknown, headers: Record<string, string> = {}, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'electric-handle': handle, ...headers } })
}

/** A short stable hash for shape handles. */
export function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

/** Waits on `set` for a wake-up, a timeout or an abort; register before reading, so nothing slips between. */
export function waiter(set: Set<() => void>, signal: AbortSignal, ms: number) {
  let done!: () => void
  const promise = new Promise<void>((resolve) => {
    done = () => {
      clearTimeout(timer)
      set.delete(done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    set.add(done)
    signal.addEventListener('abort', done)
  })
  return { promise, cancel: () => done() }
}

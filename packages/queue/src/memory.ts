import type { NewMessage, QueueDriver, QueueMessage } from './driver.ts'

export type MessageStatus = 'pending' | 'running' | 'done' | 'dead'

export interface StoredMessage {
  id: string
  job: string
  payload: unknown
  status: MessageStatus
  attempts: number
  maxAttempts: number
  runAt: Date
  key?: string
  error?: string
}

export interface MemoryQueue extends QueueDriver {
  /** Every message with its status, oldest first. Payloads are decoded. Handy for test assertions. */
  messages(job?: string): StoredMessage[]
}

/** An in-process queue for development and tests. Messages are lost on restart. */
export function memoryQueue(options: { now?: () => number } = {}): MemoryQueue {
  const now = options.now ?? Date.now
  const rows: (Omit<StoredMessage, 'payload'> & { payload: string; lockedUntil: number; finishedAt?: number })[] = []
  let seq = 0
  const find = (id: string) => rows.find((r) => r.id === id)
  return {
    async push(m: NewMessage) {
      if (m.key !== undefined && rows.some((r) => r.key === m.key)) return undefined
      const id = String(++seq)
      rows.push({ id, job: m.job, payload: m.payload, status: 'pending', attempts: 0, maxAttempts: m.maxAttempts, runAt: m.runAt, key: m.key, lockedUntil: 0 })
      return id
    },
    async reserve(jobs, lease): Promise<QueueMessage | undefined> {
      const t = now()
      const due = rows
        .filter((r) => jobs.includes(r.job) && (r.status === 'pending' || r.status === 'running') && r.runAt.getTime() <= t && r.lockedUntil <= t)
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())[0]
      if (!due) return undefined
      due.status = 'running'
      due.attempts++
      due.lockedUntil = t + lease
      return { id: due.id, job: due.job, payload: due.payload, attempt: due.attempts, maxAttempts: due.maxAttempts }
    },
    async complete(id) {
      const r = find(id)
      if (r) Object.assign(r, { status: 'done', finishedAt: now(), error: undefined })
    },
    async retry(id, runAt, error) {
      const r = find(id)
      if (r) Object.assign(r, { status: 'pending', runAt, error, lockedUntil: 0 })
    },
    async fail(id, error) {
      const r = find(id)
      if (r) Object.assign(r, { status: 'dead', error, finishedAt: now() })
    },
    async prune(before) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!
        if (r.status === 'done' && r.finishedAt! < before.getTime()) rows.splice(i, 1)
      }
    },
    messages(job) {
      return rows
        .filter((r) => job === undefined || r.job === job)
        .map(({ lockedUntil: _l, finishedAt: _f, payload, ...r }) => ({ ...r, payload: JSON.parse(payload) as unknown }))
    },
  }
}

import { defineService } from '@bolide/core'

/**
 * Where sessions live. The shape matches `CacheDriver` from `@bolide/cache`, so its
 * `redisStore(client)` works here too. Keys are hashes of the session tokens.
 */
export interface SessionStore {
  get(key: string): Promise<string | undefined>
  /** `ttl` in milliseconds. */
  set(key: string, value: string, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
}

export interface MemorySessionStore extends SessionStore {
  /** Live sessions. */
  readonly size: number
}

/** Sessions in process memory: for development and tests. They are lost on restart. */
export function memorySessionStore(options: { now?: () => number } = {}): MemorySessionStore {
  const now = options.now ?? Date.now
  const entries = new Map<string, { value: string; expires: number }>()
  const sweep = () => {
    for (const [k, e] of entries) if (e.expires <= now()) entries.delete(k)
  }
  return {
    get size() {
      sweep()
      return entries.size
    },
    async get(key) {
      const e = entries.get(key)
      if (!e) return undefined
      if (e.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      return e.value
    },
    async set(key, value, ttl) {
      // Expired sessions are never read again; sweep now and then so they don't pile up.
      if (entries.size % 1000 === 999) sweep()
      entries.set(key, { value, expires: ttl === undefined ? Infinity : now() + ttl })
    },
    async delete(key) {
      entries.delete(key)
    },
  }
}

/** The store sessions use: memory unless `authModule({ store })` picks another. */
export const SessionStore = defineService<SessionStore>({ name: 'SessionStore', factory: () => memorySessionStore() })

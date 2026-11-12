import type { CacheDriver } from './driver.ts'

export interface MemoryStoreOptions {
  /** Most entries kept; the least recently used go first. Default 10 000. */
  maxEntries?: number
  /** Clock for expiry, replaceable in tests. */
  now?: () => number
}

export interface MemoryStore extends CacheDriver {
  readonly size: number
  clear(): void
}

/** An in-process LRU store. Fine for one instance and for tests; use Redis when several instances share a cache. */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const max = options.maxEntries ?? 10_000
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`maxEntries must be a positive integer, got ${max}.`)
  const now = options.now ?? Date.now
  // Map keeps insertion order: re-inserting on read makes the first key the least recently used.
  const entries = new Map<string, { value: string; expires: number }>()
  return {
    get size() {
      return entries.size
    },
    async get(key) {
      const e = entries.get(key)
      if (!e) return undefined
      entries.delete(key)
      if (e.expires <= now()) return undefined
      entries.set(key, e)
      return e.value
    },
    async set(key, value, ttl) {
      entries.delete(key)
      entries.set(key, { value, expires: ttl === undefined ? Infinity : now() + ttl })
      while (entries.size > max) entries.delete(entries.keys().next().value!)
    },
    async delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
  }
}

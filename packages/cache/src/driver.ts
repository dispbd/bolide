import { defineService } from '@bolide/core'
import { memoryStore } from './memory.ts'

/**
 * Where a cache keeps its entries. Values arrive already encoded as strings,
 * so a driver only stores and expires them.
 */
export interface CacheDriver {
  get(key: string): Promise<string | undefined>
  /** `ttl` in milliseconds; undefined means no expiry. */
  set(key: string, value: string, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
}

/** The driver `Cache` uses: a memory store unless `cacheModule({ store })` picks another. */
export const CacheDriver = defineService<CacheDriver>({ name: 'CacheDriver', factory: () => memoryStore() })

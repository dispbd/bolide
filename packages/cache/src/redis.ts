import type { CacheDriver } from './driver.ts'

/** The part of an ioredis client the store uses. Any client with the same methods works. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: ['PX', number] | []): Promise<unknown>
  del(key: string): Promise<unknown>
}

/**
 * A store on Redis, for caches shared by several instances. Pass your own client
 * (`new Redis(url)` from ioredis); the app owns it and closes it.
 */
export function redisStore(client: RedisLike): CacheDriver {
  return {
    async get(key) {
      return (await client.get(key)) ?? undefined
    },
    async set(key, value, ttl) {
      // Redis rejects PX 0; an entry that expires now is simply not stored.
      if (ttl !== undefined && ttl < 1) return void (await client.del(key))
      await (ttl === undefined ? client.set(key, value) : client.set(key, value, 'PX', Math.ceil(ttl)))
    },
    async delete(key) {
      await client.del(key)
    },
  }
}

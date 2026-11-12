import { bind, BolideError, defineModule, defineService, Log, toMs, type Duration, type Logger, type Module, type Service } from '@bolide/core'
import { CacheDriver } from './driver.ts'

export interface CacheSetOptions {
  /** How long the entry lives. Defaults to the cache's `ttl`; no expiry when neither is set. */
  ttl?: Duration
}

/**
 * Values go through JSON: plain objects, arrays, strings, numbers, booleans and null
 * come back as they went in; a Date comes back as its ISO string.
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, options?: CacheSetOptions): Promise<void>
  delete(key: string): Promise<void>
  /**
   * The cached value, or the result of `load`, cached for next time. Concurrent misses on
   * one key share a single `load`. If the driver fails, `load` still answers and the failure is logged.
   * An `undefined` result is returned but not cached.
   */
  wrap<T>(key: string, load: () => T | Promise<T>, options?: CacheSetOptions): Promise<T>
  /** The same cache with `prefix:` before every key. */
  namespace(prefix: string): Cache
}

export interface CacheOptions {
  /** Prepended to every key as `prefix:`, e.g. the app name on a shared Redis. */
  prefix?: string
  /** Default time to live for every entry. */
  ttl?: Duration
  /** Where driver failures inside `wrap` are reported. */
  log?: Logger
}

export function createCache(driver: CacheDriver, options: CacheOptions = {}): Cache {
  const defaultTtl = options.ttl === undefined ? undefined : toMs(options.ttl, 'cache ttl')
  const inflight = new Map<string, Promise<unknown>>()
  const ttlOf = (o?: CacheSetOptions) => (o?.ttl === undefined ? defaultTtl : toMs(o.ttl, 'cache ttl'))
  const encode = (key: string, value: unknown) => {
    if (value === undefined) throw new BolideError(`cache: cannot store undefined under "${key}"; use delete() instead.`)
    const text = JSON.stringify(value)
    if (text === undefined) throw new BolideError(`cache: the value under "${key}" can't be encoded as JSON.`)
    return text
  }

  const make = (prefix: string | undefined): Cache => {
    const full = (key: string) => (prefix ? `${prefix}:${key}` : key)
    const cache: Cache = {
      async get<T>(key: string) {
        const text = await driver.get(full(key))
        return text === undefined ? undefined : (JSON.parse(text) as T)
      },
      async set(key, value, o) {
        await driver.set(full(key), encode(key, value), ttlOf(o))
      },
      async delete(key) {
        await driver.delete(full(key))
      },
      wrap<T>(key: string, load: () => T | Promise<T>, o?: CacheSetOptions) {
        const k = full(key)
        const ttl = ttlOf(o)
        const running = inflight.get(k)
        if (running) return running as Promise<T>
        const run = (async () => {
          try {
            let text: string | undefined
            try {
              text = await driver.get(k)
            } catch (e) {
              options.log?.warn('cache read failed, loading instead', { key: k, err: e })
            }
            if (text !== undefined) return JSON.parse(text) as T
            const value = await load()
            if (value !== undefined) {
              await driver.set(k, encode(key, value), ttl).catch((e) => options.log?.warn('cache write failed', { key: k, err: e }))
            }
            return value
          } finally {
            inflight.delete(k)
          }
        })()
        inflight.set(k, run)
        return run
      },
      namespace: (p) => make(prefix ? `${prefix}:${p}` : p),
    }
    return cache
  }
  return make(options.prefix || undefined)
}

/** The app's cache. Provide it with `cacheModule()`. */
export const Cache = defineService({
  name: 'Cache',
  inject: { driver: CacheDriver, log: Log },
  factory: ({ driver, log }): Cache => createCache(driver, { log }),
})

export interface CacheModuleOptions {
  /** A driver, or a service that builds one (for a client configured from env). Default: `memoryStore()`. */
  store?: CacheDriver | Service<CacheDriver, any>
  prefix?: string
  ttl?: Duration
  /** Modules whose exports the `store` service needs. */
  imports?: readonly Module[]
}

/**
 * A global module providing `Cache` (and `CacheDriver`) to the whole app.
 *
 * ```ts
 * createApp({ modules: [cacheModule({ ttl: '5m' }), users] })
 * ```
 */
export function cacheModule(options: CacheModuleOptions = {}): Module {
  if (options.ttl !== undefined) toMs(options.ttl, 'cacheModule ttl')
  const { store } = options
  const driver = store === undefined ? CacheDriver : bind(CacheDriver, isService(store) ? { useService: store } : { useValue: store })
  const impl = defineService({
    name: 'Cache',
    inject: { driver: CacheDriver, log: Log },
    factory: ({ driver, log }) => createCache(driver, { prefix: options.prefix, ttl: options.ttl, log }),
  })
  return defineModule({
    name: 'cache',
    global: true,
    imports: options.imports,
    providers: [driver, bind(Cache, { useService: impl })],
    exports: [Cache, CacheDriver],
  })
}

function isService(x: unknown): x is Service<CacheDriver, any> {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'service'
}

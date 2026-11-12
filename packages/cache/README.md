# @bolide/cache

A cache for Bolide apps: one `Cache` service, a memory driver for development and tests, and a Redis driver for caches shared between instances.

```ts
import { createApp, defineService } from '@bolide/core'
import { Cache, cacheModule } from '@bolide/cache'

const Rates = defineService({
  name: 'Rates',
  inject: { cache: Cache },
  factory: ({ cache }) => ({
    // Concurrent misses share one fetch; the result is kept for 10 minutes.
    get: (code: string) => cache.wrap(`rate:${code}`, () => fetchRate(code), { ttl: '10m' }),
  }),
})

const app = await createApp({ modules: [cacheModule({ prefix: 'shop', ttl: '5m' }), rates] })
```

`cacheModule()` is global: every module can inject `Cache` without importing it. Without it, injecting `Cache` fails at boot.

## API

- `get<T>(key)`, `set(key, value, { ttl })`, `delete(key)`.
- `wrap(key, load, { ttl })`: the cached value, or `load()`'s result, cached. Concurrent misses on one key run `load` once. Errors and `undefined` are not cached. If the driver fails (Redis down), `load` still answers and the failure is logged as a warning.
- `namespace(prefix)`: the same cache with `prefix:` before every key.
- TTLs are a `Duration`: milliseconds or `'250ms'`, `'30s'`, `'5m'`, `'1h'`, `'7d'`. A malformed one fails when the module is defined.

Values go through JSON, so what you get back is a copy; a `Date` comes back as its ISO string. `undefined` can't be stored (use `delete`).

## Drivers

| Driver | Use |
|---|---|
| `memoryStore({ maxEntries })` (default) | One instance, development, tests. LRU, 10 000 entries by default. |
| `redisStore(client)` | Several instances. Pass an ioredis client (or anything with `get`, `set(key, value, 'PX', ms)` and `del`); the app owns and closes it. |

A driver built from config is a service:

```ts
const RedisStore = defineService({
  name: 'RedisStore',
  inject: { config: RedisConfig },
  factory: ({ config }) => redisStore(new Redis(config.url)),
})
cacheModule({ store: RedisStore, imports: [configModule] })
```

In tests, `override(CacheDriver, { useValue: memoryStore() })` swaps the driver, and `app.get(CacheDriver)` lets you look inside.

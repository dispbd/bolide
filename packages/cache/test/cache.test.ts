import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BolideError, createApp, createLogger, defineModule, defineRoute, defineService, defineValue, override, type LogRecord } from '@bolide/core'
import { Cache, CacheDriver, cacheModule, createCache, memoryStore, redisStore, type RedisLike } from '../src/index.ts'

describe('memoryStore', () => {
  test('expires entries by ttl', async () => {
    let t = 0
    const store = memoryStore({ now: () => t })
    await store.set('a', '1', 100)
    await store.set('b', '2')
    t = 99
    assert.equal(await store.get('a'), '1')
    t = 100
    assert.equal(await store.get('a'), undefined)
    assert.equal(await store.get('b'), '2')
  })

  test('evicts the least recently used entry over maxEntries', async () => {
    const store = memoryStore({ maxEntries: 2 })
    await store.set('a', '1')
    await store.set('b', '2')
    await store.get('a')
    await store.set('c', '3')
    assert.equal(await store.get('b'), undefined)
    assert.equal(await store.get('a'), '1')
    assert.equal(store.size, 2)
  })

  test('rejects a bad maxEntries', () => {
    assert.throws(() => memoryStore({ maxEntries: 0 }), RangeError)
  })
})

describe('createCache', () => {
  test('round-trips JSON values, with prefixes and namespaces', async () => {
    const store = memoryStore()
    const cache = createCache(store, { prefix: 'app' })
    await cache.set('user:1', { name: 'ann', tags: ['a'] })
    assert.deepEqual(await cache.get('user:1'), { name: 'ann', tags: ['a'] })
    assert.equal(await store.get('app:user:1'), '{"name":"ann","tags":["a"]}')
    const users = cache.namespace('users')
    await users.set('2', null)
    assert.equal(await store.get('app:users:2'), 'null')
    assert.equal(await users.get('2'), null)
    await users.delete('2')
    assert.equal(await users.get('2'), undefined)
  })

  test('stored values are copies', async () => {
    const cache = createCache(memoryStore())
    const value = { n: 1 }
    await cache.set('k', value)
    value.n = 2
    assert.deepEqual(await cache.get('k'), { n: 1 })
  })

  test('undefined and unencodable values are refused', async () => {
    const cache = createCache(memoryStore())
    await assert.rejects(cache.set('k', undefined), BolideError)
    await assert.rejects(cache.set('k', () => 1), /can't be encoded/)
  })

  test('ttl: per call, then the default, as Duration strings', async () => {
    const seen: (number | undefined)[] = []
    const driver: CacheDriver = { get: async () => undefined, set: async (_k, _v, ttl) => void seen.push(ttl), delete: async () => {} }
    const cache = createCache(driver, { ttl: '5m' })
    await cache.set('a', 1)
    await cache.set('b', 1, { ttl: '2s' })
    await cache.set('c', 1, { ttl: 250 })
    assert.deepEqual(seen, [300_000, 2000, 250])
    assert.throws(() => createCache(driver, { ttl: '5 minutes' as never }), /cache ttl must be/)
  })

  test('wrap loads once for concurrent misses, then serves the cache', async () => {
    const cache = createCache(memoryStore())
    let loads = 0
    const load = async () => {
      loads++
      await new Promise((r) => setTimeout(r, 5))
      return { v: loads }
    }
    const [a, b] = await Promise.all([cache.wrap('k', load), cache.wrap('k', load)])
    assert.deepEqual(a, { v: 1 })
    assert.equal(a, b)
    assert.deepEqual(await cache.wrap('k', load), { v: 1 })
    assert.equal(loads, 1)
  })

  test('wrap does not cache errors or undefined', async () => {
    const cache = createCache(memoryStore())
    await assert.rejects(cache.wrap('k', () => Promise.reject(new Error('down'))), /down/)
    assert.equal(await cache.wrap('k', () => undefined), undefined)
    assert.equal(await cache.wrap('k', () => 7), 7)
  })

  test('wrap falls back to load when the driver fails, and logs it', async () => {
    const records: LogRecord[] = []
    const log = createLogger({ write: (r) => void records.push(r) })
    const broken: CacheDriver = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
      delete: () => Promise.reject(new Error('ECONNREFUSED')),
    }
    const cache = createCache(broken, { log })
    assert.equal(await cache.wrap('k', () => 'fresh'), 'fresh')
    assert.deepEqual(records.map((r) => r.msg), ['cache read failed, loading instead', 'cache write failed'])
    await assert.rejects(cache.get('k'), /ECONNREFUSED/)
  })
})

describe('redisStore', () => {
  test('maps onto get/set PX/del', async () => {
    const calls: unknown[][] = []
    const data = new Map<string, string>()
    const client: RedisLike = {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v, ...args) => {
        calls.push(['set', k, v, ...args])
        data.set(k, v)
        return 'OK'
      },
      del: async (k) => {
        calls.push(['del', k])
        return Number(data.delete(k))
      },
    }
    const store = redisStore(client)
    await store.set('a', '1')
    await store.set('b', '2', 1500.2)
    await store.set('c', '3', 0)
    assert.equal(await store.get('a'), '1')
    assert.equal(await store.get('missing'), undefined)
    await store.delete('a')
    assert.deepEqual(calls, [['set', 'a', '1'], ['set', 'b', '2', 'PX', 1501], ['del', 'c'], ['del', 'a']])
  })
})

describe('cacheModule', () => {
  const Users = defineService({
    name: 'Users',
    inject: { cache: Cache },
    factory: ({ cache }) => {
      let loads = 0
      return { find: (id: string) => cache.wrap(`user:${id}`, () => ({ id, loads: ++loads })) }
    },
  })
  const route = defineRoute({ method: 'GET', path: '/users/:id', inject: { users: Users }, handler: ({ params }, { users }) => users.find(params.id) })
  const users = defineModule({ name: 'users', providers: [Users], routes: [route] })
  const quiet = createLogger({ level: 'error' })

  test('provides Cache to every module (memory by default)', async () => {
    const app = await createApp({ modules: [cacheModule({ prefix: 'test' }), users], logger: quiet })
    const get = async () => (await app.fetch(new Request('http://x/users/1'))).json()
    assert.deepEqual(await get(), { id: '1', loads: 1 })
    assert.deepEqual(await get(), { id: '1', loads: 1 })
    assert.equal(await app.get(CacheDriver).get('test:user:1'), '{"id":"1","loads":1}')
  })

  test('store takes a driver or a service that builds one', async () => {
    const shared = memoryStore()
    let app = await createApp({ modules: [cacheModule({ store: shared }), users], logger: quiet })
    await app.get(Users).find('1')
    assert.equal(shared.size, 1)

    const Url = defineValue('RedisUrl', 'redis://x')
    const config = defineModule({ name: 'config', providers: [Url], exports: [Url] })
    const FromConfig = defineService({ name: 'FromConfig', inject: { url: Url }, factory: ({ url }) => (url ? shared : memoryStore()) })
    app = await createApp({ modules: [cacheModule({ store: FromConfig, imports: [config] }), users], logger: quiet })
    assert.equal(app.get(CacheDriver), shared)
  })

  test('tests can swap the driver with override()', async () => {
    const fake = memoryStore()
    const app = await createApp({ modules: [cacheModule(), users], logger: quiet, overrides: [override(CacheDriver, { useValue: fake })] })
    await app.get(Users).find('9')
    assert.equal(await fake.get('user:9'), '{"id":"9","loads":1}')
  })

  test('without cacheModule, injecting Cache fails at boot', async () => {
    await assert.rejects(createApp({ modules: [users], logger: quiet }), /injects "Cache", which is not visible/)
  })

  test('a bad ttl fails when the module is defined', () => {
    assert.throws(() => cacheModule({ ttl: '-1s' as never }), /cacheModule ttl must be/)
  })
})

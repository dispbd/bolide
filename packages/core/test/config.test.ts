import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { AppEnv, ConfigError, createApp, defineConfig, defineModule, defineService, override } from '../src/index.ts'

const DbConfig = defineConfig({
  name: 'DbConfig',
  schema: z.object({ url: z.url(), pool: z.coerce.number().int().positive().default(10) }),
  load: (env) => ({ url: env.DATABASE_URL, pool: env.DB_POOL }),
})
const Db = defineService({ name: 'Db', inject: { config: DbConfig }, factory: ({ config }) => ({ config }) })
const app = defineModule({ name: 'app', providers: [DbConfig, Db] })

test('config is loaded from env, coerced and injected', async () => {
  const a = await createApp({ modules: [app], env: { DATABASE_URL: 'postgres://localhost/x', DB_POOL: '4' } })
  assert.deepEqual(a.get(Db).config, { url: 'postgres://localhost/x', pool: 4 })
  assert.ok(Object.isFrozen(a.get(DbConfig)))
})

test('defaults from the schema apply', async () => {
  const a = await createApp({ modules: [app], env: { DATABASE_URL: 'postgres://localhost/x' } })
  assert.equal(a.get(DbConfig).pool, 10)
})

test('an invalid config stops the boot and lists every problem', async () => {
  await assert.rejects(createApp({ modules: [app], env: { DB_POOL: '-1' } }), (e) => {
    assert.ok(e instanceof ConfigError)
    assert.equal(e.config, 'DbConfig')
    assert.deepEqual(e.issues.map((i) => i.path).sort(), ['pool', 'url'])
    assert.match(e.message, /config "DbConfig" is invalid/)
    return true
  })
})

test('a test can override the config itself', async () => {
  const a = await createApp({ modules: [app], overrides: [override(DbConfig, { useValue: { url: 'mem://', pool: 1 } })] })
  assert.equal(a.get(Db).config.url, 'mem://')
})

test('AppEnv is injectable everywhere without importing', async () => {
  const Who = defineService({ name: 'Who', inject: { env: AppEnv }, factory: ({ env }) => env.USER_NAME })
  const a = await createApp({ modules: [defineModule({ name: 'm', providers: [Who] })], env: { USER_NAME: 'ann' } })
  assert.equal(a.get(Who), 'ann')
})

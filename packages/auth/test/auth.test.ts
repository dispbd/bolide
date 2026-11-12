import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createApp, createLogger, defineModule, defineRoute, HttpError, type LogRecord } from '@bolide/core'
import { authenticated, authModule, CurrentSession, hashPassword, memorySessionStore, needsRehash, Sessions, verifyPassword } from '../src/index.ts'

describe('passwords', () => {
  test('hash and verify, with salts and a self-describing format', async () => {
    const a = await hashPassword('correct horse', { cost: 1024 })
    const b = await hashPassword('correct horse', { cost: 1024 })
    assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]{22}\$[\w-]{43}$/)
    assert.notEqual(a, b)
    assert.equal(await verifyPassword('correct horse', a), true)
    assert.equal(await verifyPassword('wrong horse', a), false)
  })

  test('malformed or abusive hashes are a mismatch', async () => {
    for (const bad of ['', 'bcrypt$x', 'scrypt$1024$8$1$c2FsdA', 'scrypt$1099511627776$8$1$c2FsdA$a2V5', 'scrypt$1024$8$1$c2FsdA$a2V5$x', ...['3$8$1', '1048576$32$1', '0$8$1'].map((nrp) => `scrypt$${nrp}$c2FsdA$${'A'.repeat(43)}`)]) {
      assert.equal(await verifyPassword('x', bad), false, bad)
    }
  })

  test('needsRehash notices weaker parameters', async () => {
    const weak = await hashPassword('pw', { cost: 1024 })
    assert.equal(needsRehash(weak), true)
    assert.equal(needsRehash(weak, { cost: 1024 }), false)
    await assert.rejects(hashPassword('pw', { cost: 1000 }), RangeError)
  })
})

// A tiny app: login, whoami, a guarded route, logout.
const users = new Map([['ann', 'secret']])
const login = defineRoute({
  method: 'POST',
  path: '/login',
  body: z.object({ name: z.string(), password: z.string() }),
  inject: { session: CurrentSession },
  handler: async ({ body }, { session }) => {
    if (users.get(body.name) !== body.password) throw new HttpError(401, 'wrong name or password')
    await session.login(body.name, { theme: 'dark' })
    return { ok: true }
  },
})
const me = defineRoute({ method: 'GET', path: '/me', inject: { session: CurrentSession }, handler: (_c, { session }) => ({ userId: session.userId ?? null, data: session.data }) })
const secret = defineRoute({ method: 'GET', path: '/secret', use: [authenticated], handler: () => 'ok' })
const theme = defineRoute({ method: 'POST', path: '/theme', inject: { session: CurrentSession }, handler: async (_c, { session }) => void (await session.set('theme', 'light')) })
const logout = defineRoute({ method: 'POST', path: '/logout', inject: { session: CurrentSession }, handler: async (_c, { session }) => void (await session.logout()) })
const routes = defineModule({ name: 'routes', routes: [login, me, secret, theme, logout] })
const quiet = createLogger({ write: () => {} })

function client(app: { fetch(r: Request): Promise<Response> }) {
  let cookie = ''
  return {
    get cookie() {
      return cookie
    },
    set cookie(c: string) {
      cookie = c
    },
    async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await app.fetch(
        new Request(`http://app.test${path}`, {
          method,
          headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        }),
      )
      const set = res.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!
      return res
    },
  }
}

describe('sessions', () => {
  test('login sets a hardened cookie; the session follows it; logout clears it', async () => {
    const store = memorySessionStore()
    const app = await createApp({ modules: [authModule({ store }), routes], use: [Sessions], logger: quiet })
    const c = client(app)
    assert.deepEqual(await (await c.send('GET', '/me')).json(), { userId: null, data: {} })
    assert.equal((await c.send('GET', '/secret')).status, 401)
    assert.equal((await c.send('POST', '/login', { name: 'ann', password: 'nope' })).status, 401)

    const res = await c.send('POST', '/login', { name: 'ann', password: 'secret' })
    const set = res.headers.get('set-cookie')!
    assert.match(set, /^sid=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await (await c.send('GET', '/me')).json(), { userId: 'ann', data: { theme: 'dark' } })
    assert.equal((await c.send('GET', '/secret')).status, 200)
    await c.send('POST', '/theme')
    assert.deepEqual((await (await c.send('GET', '/me')).json()).data, { theme: 'light' })
    assert.equal(store.size, 1)

    const out = await c.send('POST', '/logout')
    assert.match(out.headers.get('set-cookie')!, /^sid=; .*Max-Age=0/)
    assert.equal(store.size, 0)
    assert.equal((await c.send('GET', '/secret')).status, 401)
  })

  test('the store keys sessions by a hash, never by the token itself', async () => {
    const keys: string[] = []
    const inner = memorySessionStore()
    const store = { ...inner, set: (k: string, v: string, t?: number) => (keys.push(k), inner.set(k, v, t)) }
    const app = await createApp({ modules: [authModule({ store }), routes], use: [Sessions], logger: quiet })
    const c = client(app)
    await c.send('POST', '/login', { name: 'ann', password: 'secret' })
    const token = c.cookie.split('=')[1]!
    assert.equal(keys.length, 1)
    assert.notEqual(keys[0], token)
  })

  test('login issues a new token (no fixation), and unknown tokens are dropped', async () => {
    const app = await createApp({ modules: [authModule(), routes], use: [Sessions], logger: quiet })
    const c = client(app)
    await c.send('POST', '/login', { name: 'ann', password: 'secret' })
    const first = c.cookie
    await c.send('POST', '/login', { name: 'ann', password: 'secret' })
    assert.notEqual(c.cookie, first)
    const stale = client(app)
    stale.cookie = first
    const res = await stale.send('GET', '/me')
    assert.deepEqual((await res.json()).userId, null)
    assert.match(res.headers.get('set-cookie')!, /^sid=; /)
    stale.cookie = 'sid=not-a-token'
    assert.equal((await (await stale.send('GET', '/me')).json()).userId, null)
  })

  test('sessions expire, and active ones are extended past half their life', async (t) => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    t.mock.method(Date, 'now', () => now)
    const store = memorySessionStore({ now: () => now })
    const app = await createApp({ modules: [authModule({ store, ttl: '10m' }), routes], use: [Sessions], logger: quiet })
    const c = client(app)
    await c.send('POST', '/login', { name: 'ann', password: 'secret' })
    now += toMinutes(4)
    assert.equal((await c.send('GET', '/me')).headers.get('set-cookie'), null, 'young sessions are not rewritten')
    now += toMinutes(2)
    const extended = await c.send('GET', '/me')
    assert.match(extended.headers.get('set-cookie')!, /Max-Age=600/)
    now += toMinutes(9)
    assert.equal((await (await c.send('GET', '/me')).json()).userId, 'ann')
    now += toMinutes(11)
    assert.equal((await (await c.send('GET', '/me')).json()).userId, null)
  })

  test('unsafe cross-origin requests are refused unless trusted', async () => {
    const app = await createApp({ modules: [authModule({ trustedOrigins: ['https://admin.test'] }), routes], use: [Sessions], logger: quiet })
    const c = client(app)
    const evil = await c.send('POST', '/login', { name: 'ann', password: 'secret' }, { origin: 'https://evil.test' })
    assert.deepEqual([evil.status, (await evil.json()).error], [403, 'cross_origin'])
    assert.equal((await c.send('POST', '/login', { name: 'ann', password: 'secret' }, { origin: 'https://app.test' })).status, 200, 'same host behind TLS termination')
    assert.equal((await c.send('POST', '/logout', undefined, { origin: 'https://admin.test' })).status, 204)
    assert.equal((await c.send('GET', '/me', undefined, { origin: 'https://evil.test' })).status, 200, 'safe methods pass')
    assert.equal((await c.send('POST', '/logout', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403, 'no Origin, but the browser says cross-site')
    assert.equal((await c.send('POST', '/logout', undefined, { 'sec-fetch-site': 'same-origin' })).status, 204)
  })

  test('cookie options and bad settings', async () => {
    const app = await createApp({ modules: [authModule({ cookie: { name: '__Host-s', secure: true, sameSite: 'Strict' } }), routes], use: [Sessions], logger: quiet })
    const set = (await client(app).send('POST', '/login', { name: 'ann', password: 'secret' })).headers.get('set-cookie')!
    assert.match(set, /^__Host-s=.*SameSite=Strict; Secure$/)
    assert.throws(() => authModule({ cookie: { name: 'a b' } }), /not a valid cookie name/)
    assert.throws(() => authModule({ cookie: { sameSite: 'None', secure: false } }), /requires cookie.secure/)
    assert.throws(() => authModule({ ttl: '10s' }), /at least a minute/)
    assert.throws(() => authModule({ trustedOrigins: ['https://a.test/path'] }), /takes origins/)
  })

  test('forgetting the Sessions middleware is explained', async () => {
    const records: LogRecord[] = []
    const app = await createApp({ modules: [authModule(), routes], logger: createLogger({ write: (r) => void records.push(r) }) })
    assert.equal((await client(app).send('GET', '/me')).status, 500)
    assert.match(String((records[0]!.fields.err as Error).message), /needs the Sessions middleware: createApp\(\{ use: \[Sessions\]/)
  })
})

function toMinutes(n: number) {
  return n * 60_000
}

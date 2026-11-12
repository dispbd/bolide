# @bolide/auth

Sessions, password hashing and guards for Bolide apps. Small on purpose: a cookie session backed by a store, scrypt passwords, CSRF protection and an `authenticated` guard. Users, roles and sign-up flows stay in your code, where they can use your own data.

```ts
import { createApp, defineRoute, defineModule, HttpError } from '@bolide/core'
import { authenticated, authModule, CurrentSession, Sessions, verifyPassword } from '@bolide/auth'

const login = defineRoute({
  method: 'POST',
  path: '/login',
  body: z.object({ email: z.email(), password: z.string() }),
  inject: { session: CurrentSession, users: Users },
  handler: async ({ body }, { session, users }) => {
    const user = await users.byEmail(body.email)
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) throw new HttpError(401, 'wrong email or password')
    await session.login(user.id)
  },
})

const profile = defineRoute({ method: 'GET', path: '/me', use: [authenticated], inject: { session: CurrentSession }, handler: (_c, { session }) => ({ id: session.userId }) })

const app = await createApp({ modules: [authModule({ store: redisStore(redis) }), usersModule], use: [Sessions] })
```

## Sessions

- `authModule({ store, ttl, cookie, trustedOrigins })` is global and provides `CurrentSession`. Add the `Sessions` middleware app-wide: it writes the cookie and checks origins. Forgetting it gives a 500 with a message saying so.
- `CurrentSession` (request-scoped) has `userId`, `data`, `login(userId, data?)`, `logout()` and `set(key, value)`. It reads the store only when a route or guard injects it.
- `login` always issues a new random token (256 bits), so a token planted before login is useless. The store keeps a SHA-256 hash of the token, so a leaked store holds no usable sessions.
- Sessions last `ttl` (default 30 days) and are extended when used after half of it. An unknown or expired token clears the cookie.
- The cookie is `HttpOnly; SameSite=Lax; Secure` by default (`cookie: { name, secure, sameSite, domain, path }`); responses that set it get `Cache-Control: no-store` unless they set their own.

## CSRF

Cookies with `SameSite=Lax` are not sent on cross-site POSTs, Bolide routes with a body only accept JSON (which a plain HTML form can't send), and `Sessions` rejects POST, PUT, PATCH and DELETE whose `Origin` names another host with 403 `cross_origin`. List other front ends in `trustedOrigins: ['https://admin.example.com']`. Hosts are compared rather than full origins, so an app behind a TLS-terminating proxy still works.

## Stores

`memorySessionStore()` (default) for development and tests. Any `@bolide/cache` driver has the same shape, so `redisStore(client)` from `@bolide/cache` works for production. A store built from config can be a service: `authModule({ store: RedisStore, imports: [configModule] })`.

## Passwords

`hashPassword(pw)` returns `scrypt$N$r$p$salt$hash` (default N = 2^15). `verifyPassword(pw, hash)` compares in constant time and treats a malformed hash as a mismatch. When you raise the cost, `needsRehash(hash)` tells you to store a fresh hash after the next successful login.

## Guards

`authenticated` sends 401 when nobody is signed in. Write other guards the same way:

```ts
const admin = defineGuard({ name: 'admin', inject: { session: CurrentSession, users: Users }, check: async (_c, { session, users }) => (await users.find(session.userId!))?.role === 'admin' })
// use: [authenticated, admin]
```

Not included yet: OAuth and social login, 2FA, passkeys, "sign out everywhere". The store and session interfaces leave room for them as separate packages.

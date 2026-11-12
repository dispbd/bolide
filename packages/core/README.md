# @bolide/core

Modules, dependency injection, routes and typed config on Web standards. About 13 KB gzipped, including Hono.

```ts
import { z } from 'zod'
import { createApp, defineConfig, defineModule, defineRoute, defineService, HttpError } from '@bolide/core'
import { listen } from '@bolide/core/node'

const DbConfig = defineConfig({
  name: 'DbConfig',
  schema: z.object({ url: z.url() }),
  load: (env) => ({ url: env.DATABASE_URL }),
})

const Users = defineService({
  name: 'Users',
  inject: { config: DbConfig },
  factory: ({ config }) => ({ find: (id: string) => (id === '1' ? { id, name: 'Ann' } : undefined) }),
  onDestroy: () => console.log('closing connections'),
})

const getUser = defineRoute({
  method: 'GET',
  path: '/:id',
  params: z.object({ id: z.string() }),
  inject: { users: Users },
  handler: ({ params }, { users }) => users.find(params.id) ?? Promise.reject(new HttpError(404, 'user not found')),
})

const users = defineModule({ name: 'users', prefix: '/users', providers: [DbConfig, Users], routes: [getUser] })

const app = await createApp({ modules: [users], openapi: { info: { title: 'Users API', version: '1.0.0' } } })
await listen(app, { port: 3000 })
```

## Ideas

- **The definition is the token.** Services are injected by reference: no strings, no decorators, no `reflect-metadata`. Types flow from `factory` to every consumer.
- **Mistakes fail at boot, not at request time.** Missing or invisible dependencies, cycles, double providers, singletons that depend on request-scoped services, duplicate routes and invalid config all stop `createApp()` with a message that says how to fix them.
- **Encapsulation like Nest.js.** A module sees its own providers, the exports of the modules it imports, and global modules.
- **Any Standard Schema library** validates params, query, body and config: zod, zod/mini, Valibot, ArkType.
- **Runs anywhere `fetch` does.** `app.fetch` is a standard handler; `@bolide/core/node` adds `listen()` with graceful shutdown.
- **Testable.** `createApp({ overrides: [override(Db, { useValue: fake })], env: {...} })`.

## Middleware and guards

```ts
const timing = defineMiddleware({
  name: 'timing',
  handle: async (_ctx, next) => {
    const start = performance.now()
    const res = await next()
    res.headers.set('server-timing', `app;dur=${(performance.now() - start).toFixed(1)}`)
    return res
  },
})

const signedIn = defineGuard({
  name: 'signedIn',
  inject: { session: Session }, // request-scoped services and CurrentRequest work here
  check: (_ctx, { session }) => {
    if (!session.user) throw new HttpError(401, 'sign in first')
    return true // false sends 403
  },
})

createApp({ modules, use: [timing] })            // every request, 404s and /openapi.json included
defineModule({ name: 'admin', use: [signedIn] }) // this module's routes
defineRoute({ ..., use: [rateLimit] })           // one route
```

They run app → module → route, outermost first, all before input is parsed. Errors from the handler, a guard or inner middleware are already responses by the time `next()` returns, so a logger anywhere in the chain can read `res.status`. Responses from handlers are copied, so middleware can set headers even on `Response.redirect()` or a proxied `fetch()` result; a response that middleware builds itself is passed on as is. Deps come from the request scope and are checked at boot: module and route middleware see what their module sees; app middleware sees built-ins, global modules and the exports of the modules passed to `createApp`.

## OpenAPI

`createApp({ openapi: { info } })` serves an OpenAPI 3.1 document at `/openapi.json` (change it with `openapi.path`). `openApiDocument(app.routes, { info })` builds the same document without serving it, e.g. for a build step.

Everything comes from the routes: path params, query, body, and the success response when a route has a `response` schema. A `response` schema also types the handler's return value. Use `summary`, `description`, `tags` (default: the module name), `operationId` (default: method plus path, e.g. `getUsersById`) and `deprecated` for the rest. Error responses (400, 413, 415 and the shared error shape) are added where they apply.

Schemas are converted through the Standard JSON Schema extension (`~standard.jsonSchema`), which zod 4.2+ and ArkType implement. A schema from a library without it still validates; the document just shows `{}` for it. Responses are not parsed at runtime, so they are documented from the schema's input side, which is what the handler is typed against and what is sent. A schema that can't be expressed as JSON Schema (e.g. `z.date()`) fails with the route's name; duplicate `operationId`s fail too. The document path takes precedence over param routes that would also match it.

## Logging

`createApp` gives every app a structured logger. Inject `Log` in services, or `RequestLog` in request-scoped code to get the request id on every record:

```ts
const Users = defineService({ name: 'Users', inject: { log: Log }, factory: ({ log }) => {
  const users = log.child({ svc: 'users' })
  return { add: (name: string) => users.info('user added', { name }) }
} })
```

- Every request gets an id: a safe incoming `x-request-id` (letters, digits, `.`, `_`, `:`, `-`, up to 128) or a new UUID. It is sent back in the `x-request-id` response header, unless the app set that header itself.
- One access line per request: method, path, matched route, status, duration and request id; `info` below 400, `warn` for 4xx, `error` for 5xx. Turn it off with `createApp({ accessLog: false })`.
- Unexpected errors are logged at `error` with the request id (or go to your `onError`).
- `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) and `LOG_FORMAT` (`json` or `pretty`; default `json` when `NODE_ENV=production`, otherwise `pretty`) come from the app env and are checked at boot.
- `createApp({ logger: createLogger({ write }) })` collects records in tests; `override(Log, { useValue })` works too. Errors in fields are logged with their stack and `cause`.

## Bindings

A module can provide a token with another implementation: `providers: [bind(Store, { useValue: memoryStore() })]` or `bind(Store, { useService: RedisStore })`. Everyone still injects `Store`. Unlike `override` (an app-level replacement, usually in tests), a binding's dependencies must be visible from its module, and an app override still beats it. Batteries use bindings to let you choose a driver.

`Duration` (`250`, `'30s'`, `'5m'`, `'1h'`, `'7d'`) and `toMs()` are shared by the batteries for TTLs, delays and timeouts.

## Scopes and lifecycle

- `singleton` (default): created at boot in dependency order; `onInit` after its deps, `onDestroy` in reverse order on `app.close()`.
- `request`: created lazily per request, disposed when the handler returns (before a streamed body is read). Inject `CurrentRequest` to read the request.

## Errors

Every error body has `error` (a machine-readable code) and `message`.

| Thrown | Response |
|---|---|
| validation failure | 400 `{ error: 'validation_failed', message, where, issues }` |
| `HttpError(status, message, details?, code?)` | `status` (400-599) `{ error: code, message, details? }`; `code` defaults to a name for the status, e.g. `not_found` |
| body without a JSON `Content-Type` | 415 `{ error: 'unsupported_media_type', message }` (blocks CSRF via simple requests) |
| body over `bodyLimit` (`createApp` option, default 1 MiB) | 413 `{ error: 'payload_too_large', message }` |
| anything else | 500 `{ error: 'internal_error', message }` (no details leak), reported to `onError` |

The body is read only for routes with a `body` schema; otherwise `ctx.body` is `undefined` and the raw `request` is there.

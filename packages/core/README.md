# @bolide/core

Modules, dependency injection, routes and typed config on Web standards. About 10 KB gzipped, including Hono.

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

const app = await createApp({ modules: [users] })
await listen(app, { port: 3000 })
```

## Ideas

- **The definition is the token.** Services are injected by reference: no strings, no decorators, no `reflect-metadata`. Types flow from `factory` to every consumer.
- **Mistakes fail at boot, not at request time.** Missing or invisible dependencies, cycles, double providers, singletons that depend on request-scoped services, duplicate routes and invalid config all stop `createApp()` with a message that says how to fix them.
- **Encapsulation like Nest.js.** A module sees its own providers, the exports of the modules it imports, and global modules.
- **Any Standard Schema library** validates params, query, body and config: zod, zod/mini, Valibot, ArkType.
- **Runs anywhere `fetch` does.** `app.fetch` is a standard handler; `@bolide/core/node` adds `listen()` with graceful shutdown.
- **Testable.** `createApp({ overrides: [override(Db, { useValue: fake })], env: {...} })`.

## Scopes and lifecycle

- `singleton` (default): created at boot in dependency order; `onInit` after its deps, `onDestroy` in reverse order on `app.close()`.
- `request`: created lazily per request, disposed when the response is sent. Inject `CurrentRequest` to read the request.

## Errors

| Thrown | Response |
|---|---|
| validation failure | 400 `{ error: 'validation_failed', where, issues }` |
| `HttpError(status, message, details?)` | `status` `{ error, details? }` |
| anything else | 500 `{ error: 'internal_error' }`, reported to `onError` |

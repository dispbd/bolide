# Phase 1: core

Goal (from the [roadmap](../roadmap.md)): router on Web standards, `defineModule`, DI with type inference, lifecycle, config, validation through Standard Schema, OpenAPI, CLI `create`/`dev`.

## Done

| Part | Branch | Notes |
|---|---|---|
| Workspace and `@bolide/core` package | `phase-1` | npm workspaces; the spike stays in `spike/`. |
| Modules and DI | `phase-1-di` | Services as tokens, typed injection, imports/exports/global modules, boot-time validation, lifecycle, request scope, typed overrides. |
| Routes and validation | `phase-1-http` | `defineRoute` with typed params/query/body, Hono behind an adapter, error mapping, `CurrentRequest`, `listen()` for Node. |
| Typed config | `phase-1` | `defineConfig` with any Standard Schema, `AppEnv`, every problem listed at boot. |
| CLI | `phase-1-cli` | `@bolide/cli`: `bolide create <dir>` (users module, config, test, OpenAPI; `--local` links a checkout) and `bolide dev` (Node `--watch` + tsx, `--port`). Tests generate a project, typecheck it, run its test, and check that `dev` restarts on change. |
| Middleware and guards | `phase-1-middleware` | `defineMiddleware` / `defineGuard` with typed, request-scoped deps; `use` on the app, modules and routes; boot-time visibility checks. App middleware also wraps 404s and the OpenAPI document. |
| Build and packaging | `phase-1-build` | `tsc` emits `dist/` with declarations; exports point consumers at `dist/` and the repo at `src/` through the `bolide-source` condition. `npm run pack:check` installs the packed tarballs into a fresh `bolide create` project and runs its typecheck and test. CI workflow runs typecheck, tests and the pack check. |
| OpenAPI | `phase-1-openapi` | OpenAPI 3.1 from route schemas through Standard JSON Schema; served by `createApp({ openapi })`. Routes gain `response` (types the return value), `status` and doc fields. |

Size: `@bolide/core` with Hono is about 13.3 KB gzipped (OpenAPI added about 2 KB, middleware about 1 KB). 88 tests plus compile-time type checks.

## Review fixes (PR #3)

The first AI review found three blocking issues, all fixed: `listen()` now rejects on server errors such as `EADDRINUSE`; overrides keep the singleton/request scope check; JSON bodies require a JSON `Content-Type` (415) and fit `bodyLimit` (413). The nits are fixed too: `HttpError` validates its status and errors share one `{ error: code, message }` shape, route clashes ignore param names, `ctx.body` is `undefined` without a schema, and `listen()` removes its signal handlers on `close()`.

## Next

Phase 1 is complete. Publishing to npm waits for the npm org/scope decision; phase 2 (auth, sessions, mail, queues) builds on middleware and guards.

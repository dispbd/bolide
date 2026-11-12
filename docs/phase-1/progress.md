# Phase 1: core

Goal (from the [roadmap](../roadmap.md)): router on Web standards, `defineModule`, DI with type inference, lifecycle, config, validation through Standard Schema, OpenAPI, CLI `create`/`dev`.

## Done

| Part | Branch | Notes |
|---|---|---|
| Workspace and `@bolide/core` package | `phase-1` | npm workspaces; the spike stays in `spike/`. |
| Modules and DI | `phase-1-di` | Services as tokens, typed injection, imports/exports/global modules, boot-time validation, lifecycle, request scope, typed overrides. |
| Routes and validation | `phase-1-http` | `defineRoute` with typed params/query/body, Hono behind an adapter, error mapping, `CurrentRequest`, `listen()` for Node. |
| Typed config | `phase-1` | `defineConfig` with any Standard Schema, `AppEnv`, every problem listed at boot. |
| OpenAPI | `phase-1-openapi` | OpenAPI 3.1 from route schemas through Standard JSON Schema; served by `createApp({ openapi })`. Routes gain `response` (types the return value), `status` and doc fields. |

Size: `@bolide/core` with Hono is 31.6 KB minified, 12.4 KB gzipped (OpenAPI added about 2 KB gzipped). 57 tests plus compile-time type checks.

## Review fixes (PR #3)

The first AI review found three blocking issues, all fixed: `listen()` now rejects on server errors such as `EADDRINUSE`; overrides keep the singleton/request scope check; JSON bodies require a JSON `Content-Type` (415) and fit `bodyLimit` (413). The nits are fixed too: `HttpError` validates its status and errors share one `{ error: code, message }` shape, route clashes ignore param names, `ctx.body` is `undefined` without a schema, and `listen()` removes its signal handlers on `close()`.

## Next

- CLI: `bolide create` and `bolide dev` (sub-task branch `phase-1-cli`).
- Middleware and guards: the extension point that phase 2 (auth) needs.
- A build step so the package can be published (today it exports TypeScript sources).

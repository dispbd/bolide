# Phase 1: core

Goal (from the [roadmap](../roadmap.md)): router on Web standards, `defineModule`, DI with type inference, lifecycle, config, validation through Standard Schema, OpenAPI, CLI `create`/`dev`.

## Done

| Part | Branch | Notes |
|---|---|---|
| Workspace and `@bolide/core` package | `phase-1` | npm workspaces; the spike stays in `spike/`. |
| Modules and DI | `phase-1-di` | Services as tokens, typed injection, imports/exports/global modules, boot-time validation, lifecycle, request scope, typed overrides. |
| Routes and validation | `phase-1-http` | `defineRoute` with typed params/query/body, Hono behind an adapter, error mapping, `CurrentRequest`, `listen()` for Node. |
| Typed config | `phase-1` | `defineConfig` with any Standard Schema, `AppEnv`, every problem listed at boot. |

Size: `@bolide/core` with Hono is 26.8 KB minified, 10.6 KB gzipped. 45 tests plus compile-time type checks.

## Next

- OpenAPI generated from route schemas (sub-task branch `phase-1-openapi`).
- CLI: `bolide create` and `bolide dev` (sub-task branch `phase-1-cli`).
- Middleware and guards: the extension point that phase 2 (auth) needs.
- A build step so the package can be published (today it exports TypeScript sources).

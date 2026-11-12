# Phase 2: progress

Plan: [plan.md](plan.md).

| Battery | Branch | Status | Notes |
|---|---|---|---|
| Logging | `phase-2-log` | done | `createLogger`, `Log`, `RequestLog`, `RequestId`; request ids and `x-request-id`; access log; errors logged with their request id; `LOG_LEVEL`/`LOG_FORMAT` checked at boot; `listen()` logs its address. `ErrorReporter` gets `{ requestId }` as a third argument. |
| Cache | `phase-2-cache` | done | `@bolide/cache`: `Cache` (`get/set/delete/wrap/namespace`), `cacheModule({ store, prefix, ttl })`, memory LRU and Redis drivers. Core gained `bind()` (module-level bindings, so a battery can take a driver) and `Duration`/`toMs()`. Packages build core first; `pack:check` installs and loads the cache from its tarball. |
| Queues and cron | `phase-2-queue` | done | `@bolide/queue`: `defineJob` (typed payload through Standard Schema, injected singletons, retries, backoff, timeout with an AbortSignal), `Queue.enqueue` with delay and idempotency keys, an in-app worker with concurrency and graceful stop, `defineSchedule` with an own UTC cron parser (one enqueue per slot across instances). Drivers: memory and Postgres (`SKIP LOCKED`, leases). CI gained an `integration` job with Postgres for `packages/*/test/int`. |
| Tracing | `phase-2-trace` | next | |
| Auth and sessions | `phase-2-auth` | | |
| Mail | `phase-2-mail` | | |
| Files | `phase-2-storage` | | |
| i18n | `phase-2-i18n` | | |

# Phase 2: progress

Plan: [plan.md](plan.md).

| Battery | Branch | Status | Notes |
|---|---|---|---|
| Logging | `phase-2-log` | done | `createLogger`, `Log`, `RequestLog`, `RequestId`; request ids and `x-request-id`; access log; errors logged with their request id; `LOG_LEVEL`/`LOG_FORMAT` checked at boot; `listen()` logs its address. `ErrorReporter` gets `{ requestId }` as a third argument. |
| Cache | `phase-2-cache` | done | `@bolide/cache`: `Cache` (`get/set/delete/wrap/namespace`), `cacheModule({ store, prefix, ttl })`, memory LRU and Redis drivers. Core gained `bind()` (module-level bindings, so a battery can take a driver) and `Duration`/`toMs()`. Packages build core first; `pack:check` installs and loads the cache from its tarball. |
| Queues and cron | `phase-2-queue` | done | `@bolide/queue`: `defineJob` (typed payload through Standard Schema, injected singletons, retries, backoff, timeout with an AbortSignal), `Queue.enqueue` with delay and idempotency keys, an in-app worker with concurrency and graceful stop, `defineSchedule` with an own UTC cron parser (one enqueue per slot across instances). Drivers: memory and Postgres (`SKIP LOCKED`, leases). CI gained an `integration` job with Postgres for `packages/*/test/int`. |
| Tracing | `phase-2-trace` | done | `Tracer` (no-op by default, `createApp({ tracer })`), server spans per request named after the route, errors recorded, `traceId` in the access log; `otelTracer(api)` adapts `@opentelemetry/api` structurally (no dependency) and continues incoming `traceparent`. Queue jobs run in consumer spans. |
| Auth and sessions | `phase-2-auth` | done | `@bolide/auth` (own, minimal, as recommended in the plan): `authModule({ store, ttl, cookie, trustedOrigins })`, `Sessions` middleware, request-scoped `CurrentSession` (`login/logout/set`, new token on login, hashed keys in the store, rolling expiry), `authenticated` guard, CSRF origin check, scrypt `hashPassword`/`verifyPassword`/`needsRehash`. Login rate limiting moves to the cache battery later (it needs atomic counters). |
| Mail | `phase-2-mail` | done | `@bolide/mail`: `Mailer.send` with checks (recipients, addresses, header injection, text or html), `mailModule({ transport, from })`, transports memory, console, SMTP (nodemailer, structural) and HTTP (`fetch`); `@bolide/mail/queue` has the `SendMail` job (queue is an optional peer). |
| Files | `phase-2-storage` | next | |
| i18n | `phase-2-i18n` | | |

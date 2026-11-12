# Phase 2: batteries

Goal (from the [roadmap](../roadmap.md)): auth, cache, queues and cron, mail, files, i18n, logging and tracing.

The batteries are what Meteor and Total.js give you out of the box and Nest makes you assemble. They must not make the core heavier: an app that uses none of them pays nothing.

## Shape of a battery

Every battery follows the same pattern, so learning one teaches the rest.

- **A token you inject.** The battery exports a service definition (`Cache`, `Queue`, `Mailer`, `Storage`, ...). Your services inject it like any other service.
- **A module factory you import.** `cacheModule({ store })` returns a global module that provides the token. Options are typed; anything read from the environment goes through `defineConfig`, so a bad value fails at boot.
- **Drivers behind a small interface.** Each battery defines a driver interface (`CacheStore`, `QueueDriver`, `MailTransport`, `StorageDriver`) and ships an in-memory driver for tests and development. Real drivers that need a third-party client take it as an optional peer dependency, never a hard one.
- **A test story.** The in-memory driver records what happened (sent mail, enqueued jobs), so tests assert on it without mocks. `override()` swaps a driver in one line.

### Packaging

Logging lives in `@bolide/core`, because the core itself logs (request errors, boot, shutdown). Every other battery is its own package (`@bolide/cache`, `@bolide/queue`, `@bolide/auth`, `@bolide/mail`, `@bolide/storage`, `@bolide/i18n`) that depends only on `@bolide/core`. Separate packages keep installs and audits small and let drivers declare their own optional peers. `pack:check` and the CLI template grow with them.

## Order and scope

Each battery is a sub-branch `phase-2-<name>` merged into `phase-2` with `--no-ff`. Later batteries build on earlier ones.

| # | Battery | Branch | Scope for this phase |
|---|---|---|---|
| 1 | Logging and tracing | `phase-2-log` | `Logger` service in core: levels, structured JSON or pretty output, child loggers with fields. Request-scoped `RequestLog` with a request id (taken from `x-request-id` or generated) and an access log line per request. `onError` defaults to the logger. Tracing: a `Tracer` interface with a no-op default and spans around requests and jobs; an OpenTelemetry adapter as a separate entry that takes `@opentelemetry/api` as an optional peer. |
| 2 | Cache | `phase-2-cache` | `Cache` with `get/set/delete/wrap(key, ttl, fn)`, namespaces, TTL. Drivers: memory (LRU with a size cap), Redis (optional peer `ioredis`). Values are JSON. `wrap` deduplicates concurrent misses. |
| 3 | Queues and cron | `phase-2-queue` | `defineJob({ name, schema, handler, retries, backoff })` with typed payloads through Standard Schema; `Queue.enqueue(job, payload, { delay })`. Workers run inside the app with a concurrency limit and stop gracefully on `close()`. Cron: `defineSchedule({ cron, job })` with an own small cron parser. Drivers: memory, Postgres (`FOR UPDATE SKIP LOCKED`, optional peer `postgres`), which fits the Postgres + Electric data layer of phase 3. |
| 4 | Auth and sessions | `phase-2-auth` | See [the auth decision](#auth) below. Sessions in a signed cookie with a server-side store (memory or Postgres), `CurrentSession` and `CurrentUser` request-scoped services, guards `authenticated` and `can(...)`, password hashing with `scrypt` from `node:crypto`, CSRF protection for cookie sessions, rate limiting on login (uses the cache). |
| 5 | Mail | `phase-2-mail` | `Mailer.send({ to, subject, text, html })`. Transports: memory (records messages), console, SMTP (optional peer `nodemailer`), and generic HTTP APIs through `fetch`. `sendLater` goes through the queue when `@bolide/queue` is present. |
| 6 | Files | `phase-2-storage` | `Storage` with `put/get/delete/url` on Web streams. Drivers: memory, local disk, S3-compatible (own SigV4 signing over `fetch`, no AWS SDK). Upload helper for `multipart/form-data` routes with size and type limits. |
| 7 | i18n | `phase-2-i18n` | Message catalogs with typed keys inferred from the default locale, ICU plural and select through `Intl.PluralRules`, number and date formatting through `Intl`, locale detection middleware (query, cookie, `Accept-Language`). |

Out of scope for this phase: OAuth and social login providers, WebAuthn, admin UIs, a job dashboard. They can come later as separate packages on top of the same interfaces.

## Auth

Auth is the largest battery and the one with the biggest choice: write a small auth of our own, or wrap an existing library such as Better Auth.

- **Own, minimal (recommended).** Sessions, passwords, guards and CSRF, about the size of the other batteries, written in Bolide's style: tokens, inferred types, boot-time errors, no decorators. The session and user lookup are interfaces, so a Better Auth adapter can be added later without changing app code.
- **Wrap Better Auth.** OAuth, 2FA, passkeys and organizations right away, but its own database schema, config style and HTTP handler sit beside Bolide's, and it is a large dependency for apps that only need a login form.

## Definition of done

Each battery has: the token and module factory, the in-memory driver plus the drivers listed above, tests (unit for the logic, integration for real drivers behind `npm run test:int` where they need Docker), a section in its package README, a type test case in `types.check.ts` style for its public types, and a line in `pack:check`. `bolide create` gains a logger by default and no other battery until the user adds one.

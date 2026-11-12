# Phase 3: progress

Plan: [plan.md](plan.md).

| # | Step | Status |
|---|---|---|
| 1 | Tables (`phase-3-schema`) | Done. `@bolide/data`: `defineTable` with column builders, inferred `Row`/`Insert`/`Patch`, tables as Standard Schema validators, camelCase↔snake_case mapping, `schemaSql` (DDL ordered by references), `readMigrations`/`migrate` (one transaction, advisory lock, checksums). Unit tests and an integration test on Postgres. |
| 2 | Mutators on the server (`phase-3-mutate`) | Done. `defineMutator` with typed `tx.get/insert/update/delete`, `MutatorError` codes mapped to statuses, `local: false` for server-only mutators. `dataModule` serves `POST /api/data/mutate` in a Postgres transaction and answers the `txid`; mutation ids make retries idempotent (`bolide_mutations`); `userId` comes from a request-scoped service; `onServer()` adds injected services without touching the browser bundle. Integration tests on Postgres. |
| 3 | Shapes and read permissions (`phase-3-shapes`) | Done. `defineShape(name, table, { where, columns })`; `whereSql` builds parameterised SQL from typed conditions; `electric()` sync source; `GET /api/data/shape/:name` applies the rule per request (401/403 on `false`), passes only Electric protocol params and makes caching private. Unit tests with a fake source; the where SQL is checked on Postgres. A test against a running Electric comes with the todos example (step 6). |
| 4 | Client (`phase-3-client`) | Done. `@bolide/client`: `createClient` with typed `mutate`, a local store per shape, pending mutations replayed over new server rows (rebase), ordered sending with retries and backoff, confirmation by txid on the sync stream with a timeout, rollback on 4xx, optimistic rows filtered by the shape's rule. `electricTransport()` in `@bolide/client/electric`. Unit tests with a fake transport and server. |
| 5 | Development without Docker, `bolide db` (`phase-3-dev`) | Next. |
| 6 | React (`phase-3-react`) | |
| 7 | Vue (`phase-3-vue`) | |
| 8 | Zero adapter (`phase-3-zero`) | Optional. |

## Notes

- Timestamps, dates and decimals are strings in rows (ISO 8601, `YYYY-MM-DD`, `"12.50"`), so a value is the same in the database driver, the sync stream, JSON and the browser.
- Generated defaults (`defaultRandom`, `defaultNow`) run where the insert runs. For optimistic inserts the id must come from the input, or the server's row would not match the client's.
- The client has its own small store instead of TanStack DB (a change from [ADR 0001](../adr/0001-core-on-hono.md), point 3). Replaying pending mutators over new rows needs control over the store, and the bundle shrinks: client, data layer and the Electric client are about 23 KB min+gzip (70 KB minified), against 82 KB gzipped for TanStack DB and the Electric client alone in phase 0. The `SyncTransport` interface still keeps the sync engine replaceable.

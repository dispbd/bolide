# Phase 0: results

Goal of the phase: check that an isomorphic mutator (one piece of code for client and server) gives optimistic UI on top of Hono + TanStack DB + ElectricSQL, measure latency and bundle size, and decide on the core.

## What was built

- `spike/core/mutator.ts`: `defineMutator`, `mutatorRegistry`, the shared `MutatorTx` interface, validation through Standard Schema.
- `spike/core/recording-tx.ts`: the client-side transaction. It reads from the local store, sees its own writes, and records operations.
- `spike/server/`: a Hono server. `POST /api/mutate` runs the same mutator in a Postgres transaction and returns the `txid`; `GET /api/shape/:table` proxies Electric.
- `spike/core/client.ts`: the client. The mutator is applied to TanStack DB collections at once, then sent to the server; the transaction settles when the `txid` comes back through Electric. A server rejection rolls the change back.
- Tests: 6 unit tests and 3 integration tests with two clients through a real Electric instance (create, toggle, rejection with rollback). All pass.

## Measurements

Localhost, Node 22, Postgres 16, Electric 1.8.1, 200 iterations. Network latency to the server is close to zero here; in real use the round trip adds to "confirmed", but not to "optimistic".

| Metric | p50, ms | p95, ms | p99, ms |
|---|---|---|---|
| Change visible in the UI (optimistic) | 0.42 | 0.95 | 1.81 |
| Confirmed: write synced back through Electric | 7.26 | 12.52 | 25.47 |
| Baseline: plain POST without sync | 5.21 | 9.88 | 12.81 |

Takeaway: the UI reacts in under 1 ms regardless of the network. Sync costs about 2 ms at p50 on top of a plain request.

| Bundle | min, KB | min+gzip, KB |
|---|---|---|
| Full client (TanStack DB + Electric + zod + mutators) | 657.9 | 157.0 |
| of which TanStack DB + electric-collection | 211.3 | 64.6 |
| of which @electric-sql/client | 54.3 | 17.3 |
| of which zod (one schema) | 443.3 | 91.2 |
| for comparison: zod/mini (same schema) | 14.5 | 5.1 |
| Server (Hono + our code, without the postgres driver) | 19.9 | 8.3 |

Takeaway: more than half of the client is full `zod`. With `zod/mini` or Valibot the client is about 70 KB gzipped, a third of Zero's client (about 230 KB). The server is 8 KB gzipped.

## Findings

1. **The model works without patching any library.** `createTransaction` from TanStack DB and `awaitTxId` from Electric are enough. No sync engine of our own is needed at this stage.
2. **Mutator names must be literal types**, or `mutate()` loses its typing. Solved with `mutatorRegistry(...)`.
3. **Rules the client cannot check** (row ownership) fit naturally under `tx.side === 'server'`. The client shows the change, the server rejects it, the UI rolls back. Covered by a test.
4. **Read permissions are not implemented yet.** The shape proxy exists, but there is no per-user filter: anyone sees every row. This is phase 3 work.
5. **The client only sees synced data.** If a row is not in the local store, the client-side run of the mutator fails with `not_found`. Such mutators need a server-only mode.
6. **Electric has an operational cost:** a separate service and `wal_level=logical`. A light framework needs a development mode without Docker; candidate for a separate task.
7. **TanStack DB is still 0.x** and its API is changing (returning `{ txid }` from handlers is already deprecated). That is why the client layer sits behind our own interface.

## Out of scope

- A comparison spike on Zero with the same example (optional).
- A development mode without Docker.

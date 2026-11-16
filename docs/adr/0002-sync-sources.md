# ADR 0002: Three sync sources, and which to use

Status: accepted (phase 4). Date: 2026-11-16.

## Context

Shapes reach the browser through the app's own route (`GET /api/data/shape/:name`), in Electric's shape protocol, so the browser code is the same whatever produces them. After phase 4 there are three producers:

- `electric({ url })`: proxies [Electric](https://electric-sql.com), a separate service that reads the WAL.
- `replicationSync(sql, { url })`: reads the WAL in the app itself, through a logical replication slot and our own `pgoutput` decoder, and keeps recent changes in memory.
- `postgresSync(sql)`: a trigger writes each change to a `bolide_changes` table and `NOTIFY` wakes the long-polls.

## Measurements

`npm run bench:sync` on one 4-core machine, Postgres 16 and the app on the same host, 8 writers inserting one row per transaction, 100 live clients on 10 shapes. Electric wasn't measured: it needs Docker, which this environment lacks.

| Source | Commit → client (p50 / p95) | Commit → all 10 clients of a shape (p50 / p95) | Inserts/s, 1 client | Inserts/s, 100 clients |
|---|---|---|---|---|
| postgresSync | 0.5 ms / 1.1 ms | 13.5 ms / 23.5 ms | 2738 | 1190 |
| replicationSync | 0.6 ms / 1.0 ms | 2.8 ms / 5.4 ms | 6319 | 1651 |
| (no sync) | | | 10488 | |

- Both are fast enough that the network decides latency.
- `postgresSync` costs writers the most: its trigger takes a lock that serialises writes to synced tables, so it stays at a quarter of the baseline. `replicationSync` costs writers only the WAL decoding and `REPLICA IDENTITY FULL`.
- With many clients the app process becomes the limit for both: with 100 clients, `replicationSync` answers about 16 000 long-polls a second (each insert reaches 10 clients) while Postgres takes the writes on the same cores. Clients of the same shape share one evaluation of the shape's rule, which keeps fan-out cheap.

## Decision

1. **Default to `replicationSync`** when Postgres has `wal_level=logical`: no extra service, writers keep most of their speed, offsets survive restarts, and rules can read other tables (`query()`).
2. **`postgresSync` for development and tests** where `wal_level` can't be changed (some managed databases, a shared dev server). The todos example picks between the two at boot.
3. **`electric()` when Electric is already there**, or for many thousands of clients per instance: Electric serves shape logs from its own cache and CDN-friendly URLs, which our sources don't. It can't follow rules that read other tables, so `dataModule` refuses those shapes with it.

## Consequences

- Each app instance needs its own replication slot; a slot left behind keeps WAL until it is dropped. The README says so, and setting `max_slot_wal_keep_size` in Postgres caps the damage.
- `replicationSync` keeps changes in memory (10 minutes by default). Clients that were away longer, and every client after a lost slot, load their shapes again.
- A change to a row that a `query()` rule reads makes every client of the affected shapes load them again. That's simple and correct, but a user who joins many lists in a row reloads each time. If it matters, a later version can send only the rows that entered or left.
- Rules run in Postgres for every batch of changes, so they mean exactly what the first load meant. The cost is one query per distinct shape and batch.

# Phase 4: progress

Plan: [plan.md](plan.md).

| # | Step | Status |
|---|---|---|
| 1 | Offline mode (`phase-4-offline`) | Done. |
| 2 | Logical replication (`phase-4-cdc`) | Done. |
| 3 | Rules across tables (`phase-4-rules`) | Done. |
| 4 | Measure and document (`phase-4-bench`) | |

## 1. Offline mode

- `createClient({ storage })` with `indexedDbStorage()` (`@bolide/client/idb`) or `memoryStorage()`. Shapes are saved with their stream position and resumed after a reload; unconfirmed mutations are saved and sent again with the same ids. Data is kept per user.
- `client.status()` / `subscribeStatus()` and `useClientStatus()` in React and Vue: `{ online, pending }`.
- `electricTransport()` resumes from `offset` + `handle` and reports failed attempts as offline.
- The todos example uses IndexedDB and shows an offline badge.
- Checked: unit tests (also on Node 20.6), an end-to-end resume on Postgres, `pack:check`, and Chromium: a reload shows the rows in about 25 ms; a todo added offline survives closing the tab and is sent when the network is back.
- `fake-indexeddb` is a dev dependency of `@bolide/client`, only for the IndexedDB storage test.
- Not covered: opening the app with no connection at all needs a service worker, which is left to the app.

## 2. Logical replication

- `replicationSync(sql, { url })` in `@bolide/data/server`: one replication connection (`postgres` is an optional peer dependency), a persistent slot, our own `pgoutput` decoder (`pgoutput.ts`) that keeps each transaction's xid, and changes in memory per table.
- Offsets are `<commit LSN>_<index>`. The app acknowledges only WAL older than the oldest change it keeps, so after a restart Postgres sends those changes again and clients resume with their offsets.
- First loads: the log position is taken before the snapshot; a logged transaction the snapshot doesn't see (`pg_current_snapshot()`) moves the start before it. Visible changes after that position are sent again, which is harmless.
- `where` runs in Postgres on each batch of new changes (`jsonb_populate_record`), so it matches as the first load does. This is one query per answered request; the bench step will show whether caching per shape is needed.
- `SyncSource` got optional `start(tables)` and `close()`; `dataModule` calls them at boot and shutdown, so a missing `wal_level=logical` or table fails at boot.
- The plan said `bolide db` would set up the publication. Instead `replicationSync` does it at boot, and `replicationSql(tables)` gives the SQL for a migration.
- Tests: the decoder (unit), and on Postgres: types and txids, rows leaving a shape, concurrent writers with first loads in between, a live wait, a restart, a lost slot, a truncate, setup errors. The client's end-to-end test runs on both Postgres sources. CI sets `wal_level=logical` on its Postgres service.

## 3. Rules across tables

- `query(table, column, where)` in `@bolide/data`, used as `{ in: query(...) }`; typed so the column types must match. `whereSql` writes a subquery (nesting up to 3) and lists each read table with its own conditions in `deps`.
- `postgresSync` and `replicationSync` answer `must-refetch` when a change to a `deps` table matches its conditions (old or new row), and live requests wake on those tables too. Changes that don't match (other users' memberships) cost nothing.
- `dataModule` tries each rule at boot (with and without a user) to find the tables it reads: they are set up with the others, and a source without `subqueries` (Electric) is refused with a message.
- The browser shows a pending change to a row with such a rule; the server's answer decides.
- Tests: SQL and deps (unit), boot refusal, and on Postgres for both sources: joining, leaving and giving away a membership, unrelated changes without reloads, live wake-ups.

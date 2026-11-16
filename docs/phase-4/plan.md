# Phase 4: own sync engine

Goal (from the [roadmap](../roadmap.md)): our own CDC transport for Postgres, read permissions for live queries, offline mode.

After phase 3 an app syncs through Electric (a separate service) or through `postgresSync` (triggers and a change log, fine for development, but it serialises writes). This phase adds a third source that needs only Postgres and scales like Electric: it reads the write-ahead log through logical replication. It also lifts two limits of phase 3: a read rule can depend on other tables (lists I'm a member of), and the browser keeps working, and keeps its unsent changes, across reloads and lost connections.

The browser side doesn't change: every source speaks Electric's shape protocol through the app's own routes, so `electricTransport()` and the React and Vue hooks work with all three.

## Steps

| # | Step | Branch | What |
|---|---|---|---|
| 1 | Offline mode | `phase-4-offline` | The client saves synced rows, shape offsets and pending mutations through a small storage interface: IndexedDB in the browser (`@bolide/client/idb`), memory in tests. After a reload the UI shows the saved rows at once, the streams resume from their offsets, and unsent mutations are sent in order. `client.online` and a hook for it. |
| 2 | Logical replication | `phase-4-cdc` | `replicationSync(sql)` in `@bolide/data/server`: a persistent replication slot and a publication for the synced tables, our own `pgoutput` decoder (it keeps the transaction id that confirms mutations), an in-memory change log, and Electric's protocol on top. A snapshot stays consistent with the stream by checking each logged transaction against the snapshot's visibility (`pg_current_snapshot()`). `bolide db` sets up the publication. Integration tests: concurrent writers, a restart of the app, a lost slot. |
| 3 | Rules across tables | `phase-4-rules` | A shape's `where` can take a subquery: `listId: { in: query(members, 'listId', { userId }) }`. The server builds the SQL; when a referenced table changes, the affected shapes get `must-refetch`, so a user who joins or leaves a list sees its todos appear or vanish. Supported by `replicationSync` and `postgresSync`; `electric()` refuses such shapes at boot. |
| 4 | Measure and document | `phase-4-bench` | Latency from mutation to another tab, and write throughput, for the three sources. The todos example gets lists shared between users, and runs on `replicationSync` when Postgres has `wal_level=logical`. ADR on when to use which source. |

Each step has unit tests, integration tests on Postgres under `npm run test:int:packages`, a README section, and a line in `pack:check` where a package changes.

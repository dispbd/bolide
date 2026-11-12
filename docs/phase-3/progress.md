# Phase 3: progress

Plan: [plan.md](plan.md).

| # | Step | Status |
|---|---|---|
| 1 | Tables (`phase-3-schema`) | Done. `@bolide/data`: `defineTable` with column builders, inferred `Row`/`Insert`/`Patch`, tables as Standard Schema validators, camelCase↔snake_case mapping, `schemaSql` (DDL ordered by references), `readMigrations`/`migrate` (one transaction, advisory lock, checksums). Unit tests and an integration test on Postgres. |
| 2 | Mutators on the server (`phase-3-mutate`) | Next. |
| 3 | Shapes and read permissions (`phase-3-shapes`) | |
| 4 | Client (`phase-3-client`) | |
| 5 | Development without Docker, `bolide db` (`phase-3-dev`) | |
| 6 | React (`phase-3-react`) | |
| 7 | Vue (`phase-3-vue`) | |
| 8 | Zero adapter (`phase-3-zero`) | Optional. |

## Notes

- Timestamps, dates and decimals are strings in rows (ISO 8601, `YYYY-MM-DD`, `"12.50"`), so a value is the same in the database driver, the sync stream, JSON and the browser.
- Generated defaults (`defaultRandom`, `defaultNow`) run where the insert runs. For optimistic inserts the id must come from the input, or the server's row would not match the client's.

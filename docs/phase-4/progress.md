# Phase 4: progress

Plan: [plan.md](plan.md).

| # | Step | Status |
|---|---|---|
| 1 | Offline mode (`phase-4-offline`) | Done. |
| 2 | Logical replication (`phase-4-cdc`) | |
| 3 | Rules across tables (`phase-4-rules`) | |
| 4 | Measure and document (`phase-4-bench`) | |

## 1. Offline mode

- `createClient({ storage })` with `indexedDbStorage()` (`@bolide/client/idb`) or `memoryStorage()`. Shapes are saved with their stream position and resumed after a reload; unconfirmed mutations are saved and sent again with the same ids. Data is kept per user.
- `client.status()` / `subscribeStatus()` and `useClientStatus()` in React and Vue: `{ online, pending }`.
- `electricTransport()` resumes from `offset` + `handle` and reports failed attempts as offline.
- The todos example uses IndexedDB and shows an offline badge.
- Checked: unit tests (also on Node 20.6), an end-to-end resume on Postgres, `pack:check`, and Chromium: a reload shows the rows in about 25 ms; a todo added offline survives closing the tab and is sent when the network is back.
- `fake-indexeddb` is a dev dependency of `@bolide/client`, only for the IndexedDB storage test.
- Not covered: opening the app with no connection at all needs a service worker, which is left to the app.

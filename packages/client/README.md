# @bolide/client

The browser side of the Bolide data layer: a local store kept in sync with [shapes](../data/README.md#shapes), and a queue of [mutations](../data/README.md#mutators) that show in the UI at once and are then confirmed or rolled back by the server.

```ts
import { createClient } from '@bolide/client'
import { electricTransport } from '@bolide/client/electric'
import { create, toggle, myTodos } from './shared/schema'

const client = createClient({
  transport: electricTransport(),  // streams shapes through the app's /api/data/shape/:name
  mutators: [create, toggle],
  userId: () => session.userId,    // for optimistic runs; the server uses its own session
})

const todos = client.shape(myTodos)
todos.subscribe(() => render(todos.rows()))  // React and Vue adapters wrap this

const m = client.mutate(toggle, { id })      // typed input; the UI updates now
await m.done                                  // confirmed and synced back, or MutationRejected
```

## How a mutation goes

1. The input is checked with the mutator's schema, and the mutator runs against the local rows. Its writes show in every shape at once. A failing check or a `MutatorError` here rejects the mutation before anything is sent.
2. Mutations are sent one at a time, in order, each with a uuid. If the network is down or the server answers 5xx, 408 or 429, the same mutation is retried with backoff (500 ms doubling to 30 s) and later ones wait behind it. The uuid makes a retry safe: the server applies a mutation once.
3. The server runs the mutator again in a transaction and answers with its transaction id. The client keeps its optimistic copy until that transaction arrives on the sync stream, so the row never flickers. If it doesn't arrive within `confirmTimeout` (default 10 s; for example, the change left the shape), the copy is dropped anyway.
4. If the server refuses (4xx), the mutation is removed and `done` rejects with `MutationRejected` (`status`, `code`, `message`). `onRejected` hears about every rejection, also the ones nobody awaits.

Whenever rows arrive from the server, pending mutations are replayed over them in order, like a rebase. A mutation that no longer applies (its row was deleted, or an earlier mutation it built on was rejected) shows nothing while it waits for the server's answer.

Optimistic rows are shown in a shape only if the shape's `where` would include them, so giving a todo away removes it from "my todos" at once. Rows that came from the server are shown as the server sent them.

Mutators with `local: false` skip step 1's local run and change nothing until the server's rows arrive.

## Shapes

`client.shape(shape)` returns a view with `rows()`, `status` (`loading`, `ready`, `error`), `ready` (a promise) and `subscribe(listener)`. The stream starts with the first subscriber and stops a tick after the last leaves, so a component that remounts at once (React StrictMode, a route change) keeps it. `rows()` returns the same array until something changes, which suits `useSyncExternalStore`. Rows hold the shape's columns only.

## Transports

`electricTransport()` (from `@bolide/client/electric`, with `@electric-sql/client` as a peer dependency) speaks Electric's protocol to the app's own shape route, never to Electric directly. On the server, `postgresSync()` from `@bolide/data/server` speaks the same protocol from Postgres alone, for development without Docker. A transport is a small interface (`SyncTransport`), so tests can use their own.

In Node (tests, server rendering), Electric's client keeps a 60-second timer after the last stream stops, which delays the process's exit. Run tests with `--test-force-exit`.

The store is our own rather than TanStack DB's: it is smaller (client, data layer and Electric client are about 23 KB minified and gzipped) and lets pending mutations be replayed by running the mutators again, not by patching rows.

`client.close()` stops the streams and the sending. Mutations not yet confirmed reject with code `closed`; with a `storage`, they stay saved and the next session sends them.

## Offline

Give the client a `storage` and it works through a lost connection and a reload:

```ts
import { indexedDbStorage } from '@bolide/client/idb'

const client = createClient({ transport: electricTransport(), mutators, storage: indexedDbStorage() })
client.subscribeStatus(() => render(client.status()))  // { online: false, pending: 3 }
```

- Each shape's rows are saved with their stream position (at most every 200 ms). After a reload the shape is `ready` with the saved rows at once, and the stream resumes from that position instead of loading everything again. A must-refetch from the server drops the saved rows.
- Every unconfirmed mutation is saved until the server confirms or refuses it. A reload restores them in order, shows them again and sends them with the same ids, so the server applies each once even if the first session's request did get through.
- Saved data belongs to the user who was signed in (`userId()` when the client was created). Another user on the same browser starts empty and sends nothing of the first user's.
- `status()` says whether the server answered the last request or stream poll and how many changes wait for it. A browser `online` event retries at once instead of waiting out the backoff.
- `client.saved()` resolves when everything is written, for tests or before closing a tab on purpose.

The page itself still comes from the server: to open the app with no connection at all, cache it with a service worker (not part of Bolide). Tabs of one origin share the storage. Two tabs opened at once can both send the same saved mutation; the mutation id makes that harmless. `memoryStorage()` keeps everything in a `Map`, for tests. Any other store fits the `ClientStorage` interface (`get`, `set`, `delete`, `list(prefix)`); values must survive `structuredClone`.

Not yet: queries across shapes.

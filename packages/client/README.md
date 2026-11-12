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

`client.shape(shape)` returns a view with `rows()`, `status` (`loading`, `ready`, `error`), `ready` (a promise) and `subscribe(listener)`. The stream starts with the first subscriber and stops with the last. `rows()` returns the same array until something changes, which suits `useSyncExternalStore`. Rows hold the shape's columns only.

## Transports

`electricTransport()` (from `@bolide/client/electric`, with `@electric-sql/client` as a peer dependency) speaks Electric's protocol to the app's own shape route, never to Electric directly. On the server, `postgresSync()` from `@bolide/data/server` speaks the same protocol from Postgres alone, for development without Docker. A transport is a small interface (`SyncTransport`), so tests can use their own.

In Node (tests, server rendering), Electric's client keeps a 60-second timer after the last stream stops, which delays the process's exit. Run tests with `--test-force-exit`.

The store is our own rather than TanStack DB's: it is smaller (client, data layer and Electric client are about 23 KB minified and gzipped) and lets pending mutations be replayed by running the mutators again, not by patching rows.

Not yet: keeping pending mutations across page reloads (phase 4), queries across shapes.

# Phase 3: data layer and optimistic UI

Goal (from the [roadmap](../roadmap.md)): a shared schema and mutator format, a typed client, Electric/Zero adapters, a mutation queue with rollback, React and Vue adapters.

This is the Meteor part of Bolide: write a change once, and it shows in the UI at once, runs again on the server with the server's rules, and syncs to every other client. Phase 0 showed the model works on Hono + TanStack DB + Electric without patching any library ([results](../phase-0/results.md)). This phase turns the spike into packages with Bolide's guarantees: inferred types, boot-time errors, no decorators, and the sync engine behind our own interface ([ADR 0001](../adr/0001-core-on-hono.md)).

## The model in one example

```ts
// shared/schema.ts: imported by the server and the browser
export const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid(),
})

export const toggle = defineMutator({
  name: 'todos.toggle',
  input: v.object({ id: v.string() }),
  async run({ tx, input }) {
    const todo = await tx.get(todos, input.id)          // typed row
    if (!todo) throw new MutatorError('not_found', 'todo not found')
    await tx.update(todos, input.id, { done: !todo.done })
  },
})

// Who may read what is a server rule, written next to the table.
export const myTodos = defineShape(todos, { where: (user) => ({ ownerId: user.id }) })

// browser
const client = createClient({ url: '/api', mutators: [toggle], shapes: [myTodos] })
const list = useShape(myTodos)          // React or Vue, live and typed
client.mutate(toggle, { id })           // UI changes now; rolls back if the server says no
```

## Packages

| Package | Runs on | What it holds |
|---|---|---|
| `@bolide/data` | both | `defineTable` and column types, `defineMutator`, `defineShape`, the `MutatorTx` interface, `MutatorError`. No server or browser code, so it is small in the client bundle. |
| `@bolide/data/server` (subpath) | server | `dataModule({ sql, mutators, shapes, sync })`: `POST /mutate` runs a mutator in a Postgres transaction and returns its `txid`; `GET /shape/:name` serves a shape with its read rule applied. Injected services and the session reach mutators the same way they reach routes. |
| `@bolide/client` | browser | `createClient`: local store, mutation queue with rollback, a `SyncTransport` interface, the Electric transport (TanStack DB underneath, pinned). |
| `@bolide/react`, `@bolide/vue` | browser | `useShape`, `useRow`, `useMutation` with status (pending, confirmed, rejected). Thin: all logic stays in `@bolide/client`. |

## Order and scope

Each step is a sub-branch `phase-3-<name>` merged into `phase-3` with `--no-ff`.

| # | Step | Branch | Scope |
|---|---|---|---|
| 1 | Tables | `phase-3-schema` | `defineTable` with a small set of column types (text, integer, numeric, boolean, uuid, timestamp, json, enum; nullable, default, primary key). Row types are inferred for reads and inserts. Each table doubles as a Standard Schema validator for rows. `bolide db sql` prints the `CREATE TABLE` statements; migrations stay plain SQL files with a tiny ordered runner (`bolide db migrate`), not a diffing tool. |
| 2 | Mutators on the server | `phase-3-mutate` | `defineMutator` over tables, typed `tx.get/insert/update/delete/query`. The server `MutatorTx` on the Postgres driver from phase 2 (`postgres`), one transaction per mutation, `txid` returned. Mutators get injected services and the current user (`inject`, as in routes), and `tx.side` for server-only rules. Idempotency by mutation id, so a retried request does not apply twice. Errors map to 400/403/404/409. |
| 3 | Shapes and read permissions | `phase-3-shapes` | `defineShape(table, { where, columns })`. The where clause is built from a typed object (`{ ownerId: user.id }`, `in`, comparisons), never from client SQL, and is sent to Electric as a parameterised `where`. The client names a shape; it never sends a table or a filter. This closes finding 4 of phase 0 (anyone could read every row). |
| 4 | Client | `phase-3-client` | `createClient` with typed `mutate(mutator, input)`. A queue keeps mutations in order, applies them locally at once, sends them one by one, waits for the `txid` to sync back, and rolls back a rejected one together with every later local change that read from it (rebase). Offline: the queue waits and retries with backoff; it is in memory in this phase (persistence is phase 4). Server-only mutators (`clientRun: false`) skip the local run, which fixes finding 5 of phase 0. |
| 5 | Development without Docker | `phase-3-dev` | A second `SyncTransport` that needs only Postgres: the server streams changes of a shape over SSE, fed by `LISTEN/NOTIFY` from triggers that `bolide db` installs. It is for development and tests, not for scale; Electric stays the production transport. This closes finding 6 of phase 0. |
| 6 | React | `phase-3-react` | Hooks on `useSyncExternalStore`. An example app in `examples/todos` built by `bolide create --template todos`. |
| 7 | Vue | `phase-3-vue` | Composables with `shallowRef`, same API as React. |
| 8 | Zero adapter | `phase-3-zero` | Optional, last. A spike that maps tables, shapes and mutators onto Zero to check that the transport interface really is engine-neutral. Ships only if it fits without bending the core. |

Out of scope for this phase: our own sync engine and CDC (phase 4), offline persistence across reloads (phase 4), Svelte and Solid adapters (phase 5), a schema-diffing migration tool.

## Choices to confirm

- **Schema: our own `defineTable`, not Drizzle (recommended).** One definition gives SQL, row types, validation and the client's column list, with no dependency in the browser bundle. Drizzle has migrations and a query builder, but it would be a second schema language beside Standard Schema, and its types are heavy in the client. An adapter that reads a Drizzle schema can come later.
- **Zero stays optional (step 8).** Electric covers production; Zero's own server and permissions model overlap with what this phase builds.

## Definition of done

Each package has tests (unit with the in-memory store and a fake transport; integration against Postgres and Electric under `npm run test:int`), a README, type tests for inferred row and input types, and a line in `pack:check`. The todos example runs with `bolide dev` against Postgres alone, and with Electric through `docker compose`. The client bundle size is measured again and recorded in `progress.md`; the target is under 80 KB gzipped for client, React adapter and a light schema library.

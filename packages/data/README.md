# @bolide/data

Tables, mutators and shapes that the server and the browser share. One table definition gives row types, validation and SQL; a mutator is a change written once and run both optimistically in the browser and for real on the server. a shape is a set of rows the browser may sync, with its read rule kept on the server. The browser client comes next ([phase 3 plan](../../docs/phase-3/plan.md)).

The root entry has no server code and no dependencies beyond Standard Schema types, so it is cheap in a browser bundle. Server-only parts (the mutation endpoint, SQL, migrations) are in `@bolide/data/server`, which needs `@bolide/core`.

## Tables

```ts
import { defineTable, t, type Row, type Insert, type Patch } from '@bolide/data'

export const users = defineTable('users', {
  id: t.uuid().primaryKey().defaultRandom(),
  email: t.text().unique(),
  role: t.enum(['admin', 'member']).default('member'),
})

export const todos = defineTable('todos', {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid().references(() => users),
  note: t.text().nullable(),
  createdAt: t.timestamp().defaultNow(),
})

type Todo = Row<typeof todos>       // { id: string; title: string; done: boolean; ownerId: string; note: string | null; createdAt: string }
type NewTodo = Insert<typeof todos> // id, title and ownerId required; the rest optional
type TodoPatch = Patch<typeof todos> // any column but the primary key
```

- **Column types:** `text`, `integer` (32-bit), `real`, `numeric` (a decimal string such as `"12.50"`, so money keeps its precision), `boolean`, `uuid`, `timestamp` (an ISO 8601 string with a zone), `date` (`YYYY-MM-DD`), `json<T>()` (`jsonb`), `enum([...])` (`text` with a check constraint). Timestamps and decimals are strings so they survive JSON on every hop between the database, the sync stream and the browser unchanged.
- **Modifiers:** `.primaryKey()` (exactly one per table: sync addresses rows by it), `.nullable()`, `.default(value)`, `.defaultRandom()` for uuids, `.defaultNow()` for timestamps, `.unique()`, `.references(() => table)`, `.named('sql_name')`.
- **Names:** keys are camelCase in code and snake_case in SQL (`ownerId` is `owner_id`). `toSqlRow` and `fromSqlRow` convert.
- **Validation:** a table is a [Standard Schema](https://standardschema.dev) for its inserts. It reports bad and unknown columns, and its output is the full row with defaults filled in. `checkPatch(table, value)` checks updates. Generated defaults (`defaultRandom`, `defaultNow`) are computed where the insert runs; for a row created optimistically in the browser, pass the id in yourself so the server stores the same one.
- **Mistakes fail at definition:** a missing or nullable primary key, two keys mapping to one SQL name, a name that isn't a SQL identifier, a default of the wrong type.

## SQL and migrations

```ts
import { migrate, readMigrations, schemaSql } from '@bolide/data/server'

// Once, to start the first migration file:
console.log(schemaSql([users, todos])) // CREATE TABLE statements, referenced tables first

// At startup, or from a deploy script:
await migrate(sql, await readMigrations('migrations'))
```

Migrations are plain SQL files named `0001_create_todos.sql`, `0002_add_due_date.sql`, and so on, applied in order. There is no schema diffing: you write each change, and you can read exactly what runs. `migrate`:

- records what it applied in `bolide_migrations`, and refuses to run if an applied file was edited afterwards (write a new migration instead);
- applies every pending file in one transaction, so a failure leaves the database as it was (statements that can't run in a transaction, such as `CREATE INDEX CONCURRENTLY`, don't belong in these files);
- holds an advisory lock, so app instances that start together don't migrate twice.

`sql` is a [postgres.js](https://github.com/porsager/postgres) client, or anything with `unsafe(query, params)` and `begin(fn)`.

## Mutators

```ts
import { defineMutator, MutatorError } from '@bolide/data'

export const toggle = defineMutator({
  name: 'todos.toggle',
  input: z.object({ id: z.uuid() }),
  async run({ tx, input, side, userId }) {
    const todo = await tx.get(todos, input.id)
    if (!todo) throw new MutatorError('not_found', 'no such todo')
    // Rules the browser can't check run on the server only; a rejection rolls the browser back.
    if (side === 'server' && todo.ownerId !== userId) throw new MutatorError('forbidden', 'not your todo')
    await tx.update(todos, input.id, { done: !todo.done })
  },
})
```

- `tx.get`, `tx.insert`, `tx.update` and `tx.delete` take a table and are typed by it. Values are checked against the table on the server before they reach SQL. `tx.get` locks the row (`FOR UPDATE`), so read-then-write mutators don't lose concurrent changes.
- `MutatorError` codes become HTTP statuses: `invalid_input` 400, `forbidden` 403, `not_found` 404, `conflict` 409. Any other error is a 500 and rolls the transaction back too.
- `local: false` marks a mutator the browser can't run (it needs rows the browser doesn't have, or secrets): the browser sends it and waits.
- Names are stable identifiers (`'todos.toggle'`): the browser sends them, so renaming one is a breaking change for open tabs.

### On the server

```ts
import { dataModule, onServer } from '@bolide/data/server'

const app = await createApp({
  modules: [
    dataModule({
      sql,                       // postgres.js client, or a service token that provides one
      tables: [todos, users],
      mutators: [toggle, placeOrderOnServer],
      userId: CurrentUserId,     // a request-scoped service: the signed-in user's id, or undefined
    }),
  ],
})
```

`POST /api/data/mutate` takes `{ id, name, input }` and answers `{ txid }`. The browser waits for that transaction id on the sync stream before it drops its optimistic copy. The `id` is a uuid the browser picks: sending the same mutation again (a retry after a dropped connection) returns the first `txid` and doesn't apply it twice. These ids are kept in a `bolide_mutations` table, created at boot.

`onServer(mutator, { inject, run })` gives a mutator a server-only body with injected services (payments, mail, secrets). The browser still runs the shared body optimistically; the server file and its imports never reach the bundle.

```ts
export const placeOrderOnServer = onServer(placeOrder, {
  inject: { payments: Payments },
  async run({ tx, input, userId }, { payments }) {
    const charge = await payments.charge(userId!, input.total)
    await tx.insert(orders, { id: input.id, userId: userId!, chargeId: charge.id })
  },
})
```

## Shapes

```ts
import { defineShape } from '@bolide/data'

export const myTodos = defineShape('todos.mine', todos, {
  where: ({ userId }) => (userId ? { ownerId: userId } : false), // false: 401 when signed out, 403 otherwise
})
export const directory = defineShape('users.directory', users, { columns: ['email'] }) // never send password hashes
```

The browser asks for a shape by name and never sends a table, columns or a filter, so anyone who opens the network tab still gets only what `where` allows. `where` runs on the server for every request and returns conditions joined with AND: a value means equality, `null` means IS NULL, and `{ in: [...] }`, `{ ne }`, `{ gt }`, `{ gte }`, `{ lt }`, `{ lte }` compare. Column names come from the table and every value is a SQL parameter. JSON columns can't be filtered on.

### Rules that read other tables

`query(table, column, where)` is the list of `column` values of the `table` rows that match `where`, for `{ in: ... }`:

```ts
import { defineShape, query } from '@bolide/data'

export const sharedTodos = defineShape('todos.shared', todos, {
  where: ({ userId }) => (userId ? { listId: { in: query(members, 'listId', { userId }) } } : false),
})
```

The server runs it as a subquery. When a `members` row that matches `{ userId }` is added, changed or deleted, the shape's clients load it again, so todos appear and vanish as the user joins and leaves lists; changes to other users' memberships cost them nothing. Queries can nest three deep, and the column types must match (TypeScript checks it). `replicationSync()` and `postgresSync()` follow such rules; `dataModule` refuses them at boot with `electric()`, which wouldn't notice the other table change. In the browser, a pending change to a row with such a rule is shown, and the server's answer decides.

On the server, add the shapes and a sync source to `dataModule`:

```ts
import { dataModule, electric } from '@bolide/data/server'

dataModule({ sql, tables, mutators, shapes: [myTodos, directory], sync: electric({ url: process.env.ELECTRIC_URL! }), userId: CurrentUserId })
```

`GET /api/data/shape/todos.mine` proxies the [Electric](https://electric-sql.com) shape protocol. Only Electric's own protocol params (`offset`, `handle`, `live`, `cursor`...) pass through from the browser. Cache headers become `private` with `Vary: cookie, authorization`, because the rows depend on who asks. For Electric Cloud, pass `sourceId` and `secret`; they stay on the server.

### Without Electric: logical replication

Which source to use, with measurements: [ADR 0002](../../docs/adr/0002-sync-sources.md).

`replicationSync(sql, { url })` reads Postgres's write-ahead log itself, so it needs no extra service and doesn't slow writers down. It needs `wal_level=logical` (Postgres 13 or later), like Electric:

```ts
import { dataModule, replicationSync } from '@bolide/data/server'

dataModule({ sql, tables, mutators, shapes, sync: replicationSync(sql, { url: process.env.DATABASE_URL! }), userId: CurrentUserId })
```

- At boot it checks `wal_level`, creates the publication `bolide` with the shapes' tables and sets their `REPLICA IDENTITY FULL`, so an update that moves a row out of a shape is seen. A database user that may not change tables can run `replicationSql(tables)` in a migration instead, with `install: false`. Mistakes fail at boot with what to do.
- It opens one replication connection (with the `postgres` package) on a slot named `bolide`. The slot survives restarts: the app tells Postgres to keep the WAL of the changes it still holds, and reads them again after a restart, so clients resume where they were. Each running instance of the app needs its own slot (`slot: 'bolide_' + instanceId`); a slot left behind by an instance that is gone keeps WAL until it is dropped (`select pg_drop_replication_slot('...')`).
- Changes are kept in memory for 10 minutes (`keep`, and at most `maxChanges` per table). A client further behind, or one from before a lost slot or a `TRUNCATE`, loads its shape again.
- Offsets are WAL positions, so they mean the same on every instance and after a restart.
- If the replication connection drops, it reconnects with backoff and reads on from where it was. The first failure of each outage and the recovery go to `log` (default `console.warn`): `replicationSync(sql, { url, log: (msg, err) => logger.warn(msg, { err }) })`.
- A first load reads the table in a snapshot and starts the stream before any transaction that the snapshot doesn't include, by its transaction id. Changes the snapshot already has may be sent again, which the client applies without effect.
- Each live request runs the shape's `where` on the new changes in Postgres, so a change matches exactly as the first load would have matched it.

### Without Electric: development and tests

Electric is a separate service, and both it and `replicationSync` need `wal_level=logical`. For development and tests, `postgresSync(sql)` serves the same shape protocol from Postgres alone, so the browser keeps using `electricTransport()`:

```ts
import { dataModule, electric, postgresSync } from '@bolide/data/server'

const sync = process.env.ELECTRIC_URL ? electric({ url: process.env.ELECTRIC_URL }) : postgresSync(sql)
dataModule({ sql, tables, mutators, shapes, sync, userId: CurrentUserId })
```

The first time a shape of a table is asked for, it installs a trigger on that table that records each change, with its transaction id, in a `bolide_changes` table and wakes waiting long-polls with `NOTIFY`. `devSyncSql(tables)` returns that SQL if you'd rather put it in a migration (and pass `install: false`). Writers to synced tables take a shared lock until they commit, so changes are read in commit order; that serialises writes, which is the reason it is for development and tests only. Recorded changes are kept for a day (`keep`); a client further behind loads the shape again.

# @bolide/data

Tables, mutators and shapes that the server and the browser share. This package is the schema part: one table definition gives row types, validation and SQL. Mutators and shapes come next ([phase 3 plan](../../docs/phase-3/plan.md)).

The root entry has no server code and no dependencies beyond Standard Schema types, so it is cheap in a browser bundle. Server-only helpers (SQL, migrations) are in `@bolide/data/server`.

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

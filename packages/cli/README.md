# @bolide/cli

```bash
npx @bolide/cli create my-app     # new project: a users module, config, a test, OpenAPI
cd my-app && npm install
npm run dev                       # bolide dev: restarts when a file changes
```

## Commands

| Command | What it does |
|---|---|
| `bolide create <dir>` | Writes a new project. Refuses a non-empty directory unless `--force`, which adds the scaffold around existing files and never overwrites them (it lists the ones it kept). Dependencies are pinned to the CLI's own version; `--local <path>` links `@bolide/*` from a local Bolide checkout through `file:` dependencies instead (useful until the packages are published). |
| `bolide dev [entry]` | Runs the entry with Node's built-in `--watch` and tsx, so any change to the entry or a file it imports restarts the app. The entry defaults to `"bolide": { "entry": "..." }` in package.json, then `src/main.ts`. `--port <n>` sets `PORT`. |
| `bolide db sql [schema]` | Prints `CREATE TABLE` statements for the tables (`defineTable`) a module exports, referenced tables first: the start of a first migration (`bolide db sql > migrations/0001_init.sql`). The module defaults to `"bolide": { "schema": "..." }` in package.json, then `src/schema.ts`. |
| `bolide db migrate` | Applies the pending `migrations/NNNN_name.sql` files to `DATABASE_URL` in one transaction (see [@bolide/data](../data/README.md#sql-and-migrations)). `--dir <path>` picks another folder. Needs `postgres` in the project. |

Mistakes in arguments exit with code 2 and the help text; problems the user can fix (a missing entry, a non-empty directory) exit with 1 and say how to fix them.

## Why no extra watcher

`node --watch` already tracks the module graph, so the CLI has one dependency (tsx, for TypeScript) and no file-watcher library. The CLI itself ships compiled JavaScript.

# @bolide/cli

```bash
npx @bolide/cli create my-app     # new project: a users module, config, a test, OpenAPI
cd my-app && npm install
npm run dev                       # bolide dev: restarts when a file changes
```

## Commands

| Command | What it does |
|---|---|
| `bolide create <dir>` | Writes a new project. Refuses a non-empty directory unless `--force`. `--local <path>` links `@bolide/*` from a local Bolide checkout through `file:` dependencies (useful until the packages are published). |
| `bolide dev [entry]` | Runs the entry with Node's built-in `--watch` and tsx, so any change to the entry or a file it imports restarts the app. The entry defaults to `"bolide": { "entry": "..." }` in package.json, then `src/main.ts`. `--port <n>` sets `PORT`. |

Mistakes in arguments exit with code 2 and the help text; problems the user can fix (a missing entry, a non-empty directory) exit with 1 and say how to fix them.

## Why no extra watcher

`node --watch` already tracks the module graph, so the CLI has one dependency (tsx, for TypeScript) and no file-watcher library. It ships TypeScript sources and loads them through tsx until the build step lands.

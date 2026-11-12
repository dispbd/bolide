# Todos

A [Bolide](https://github.com/dispbd/bolide) app with live data: a change shows at once, is checked again on the server, and reaches your other tabs. Made with `bolide create my-app --template todos`.

```bash
npm install
docker compose up -d postgres   # or set DATABASE_URL to your own Postgres
npm run dev                     # applies migrations, then http://localhost:3000
npm test                        # DATABASE_URL=... npm test also runs the server tests
```

Open the page in two tabs and add a todo: it shows in the first at once and in the second a moment later. A private window is another user and sees nothing of yours.

## Where things are

- `src/shared/schema.ts`: the table, the shape (who may read what) and the mutators (every change the UI can make). The server and the browser import the same file.
- `src/client/`: the React UI. `useShape(myTodos)` gives live rows; `useMutation(toggleTodo)` changes them.
- `src/app.ts`: the server. `dataModule` serves `POST /api/data/mutate` and `GET /api/data/shape/todos.mine`.
- `src/web.ts`: the page and the browser bundle, built by esbuild on request.
- `src/user.ts`: who is asking. Each browser is an anonymous user with an id in a cookie; swap in sessions from `@bolide/auth` for real accounts.
- `migrations/`: plain SQL, applied in order. Start a new one with `npm run db:sql`, which prints the tables as SQL.

## Sync: Postgres alone or Electric

By default shapes are served from Postgres alone (`postgresSync`): a trigger records each change and the browser long-polls for them. That needs nothing but Postgres and suits development and small apps, but it serialises writes to synced tables.

For production, run [Electric](https://electric-sql.com) and set `ELECTRIC_URL`. The browser code doesn't change: both speak the same protocol through the app's own routes, which add the read rules.

```bash
docker compose --profile electric up -d
ELECTRIC_URL=http://localhost:3001 npm run dev
```

## Production

```bash
DATABASE_URL=... npm run db:migrate
DATABASE_URL=... ELECTRIC_URL=... npm start   # minified bundle, built once
```

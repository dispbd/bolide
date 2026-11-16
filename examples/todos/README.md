# Todos

A [Bolide](https://github.com/dispbd/bolide) app with live data: a change shows at once, is checked again on the server, and reaches your other tabs. Made with `bolide create my-app --template todos`.

```bash
npm install
docker compose up -d postgres   # or set DATABASE_URL to your own Postgres
npm run dev                     # applies migrations, then http://localhost:3000
npm test                        # DATABASE_URL=... npm test also runs the server tests
```

Open the page in two tabs and add a todo: it shows in the first at once and in the second a moment later. A private window is another user and sees nothing of yours, until you press **Share** and open the link there: the list appears, and changes from either side show live. **Leave** takes it away again.

## Where things are

- `src/shared/schema.ts`: the tables, the shapes (who may read what) and the mutators (every change the UI can make). The server and the browser import the same file. A user reads the lists they are a member of and their todos: `{ listId: { in: query(members, 'listId', { userId }) } }`.
- `src/client/`: the React UI. `useShape(myTodos)` gives live rows; `useMutation(toggleTodo)` changes them. The client keeps rows and unsent changes in IndexedDB, so a reload shows them at once.
- `src/app.ts`: the server. `dataModule` serves `POST /api/data/mutate` and `GET /api/data/shape/:name`.
- `src/web.ts`: the page and the browser bundle, built by esbuild on request.
- `src/user.ts`: who is asking. Each browser is an anonymous user with an id in a cookie; swap in sessions from `@bolide/auth` for real accounts.
- `migrations/`: plain SQL, applied in order. Start a new one with `npm run db:sql`, which prints the tables as SQL.

## Sync

Shapes are served from Postgres alone. With `wal_level=logical` (as in `docker-compose.yml`), the app reads changes from the write-ahead log (`replicationSync`), which doesn't slow writers down. Without it, a trigger records each change (`postgresSync`): fine for development, but it serialises writes to synced tables. `src/app.ts` picks one at boot.

[Electric](https://electric-sql.com) would work for rules on one table, but these rules read `members` as well, which Electric doesn't follow, so `dataModule` refuses it at boot.

## Production

```bash
DATABASE_URL=... npm run db:migrate
DATABASE_URL=... npm start   # minified bundle, built once
```

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { z } from "zod";
import {
  createApp,
  createLogger,
  CurrentRequest,
  defineModule,
  defineService,
  type App,
} from "@bolide/core";
import {
  defineMutator,
  defineShape,
  defineTable,
  MutatorError,
  t,
} from "@bolide/data";
import {
  dataModule,
  devSyncSql,
  postgresSync,
  schemaSql,
} from "@bolide/data/server";
import { createClient, MutationRejected } from "../../src/index.ts";
import { electricTransport } from "../../src/electric.ts";

// The whole loop on Postgres alone: browser client → mutate route → transaction → change log → shape stream → client.
const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:54321/bolide";
const schema = `bolide_e2e_${process.pid}`;
const admin = postgres(url, { onnotice: () => {} });
const sql = postgres(url, {
  onnotice: () => {},
  connection: { search_path: schema },
});

const todos = defineTable("todos", {
  id: t.uuid().primaryKey(),
  title: t.text(),
  done: t.boolean().default(false),
  ownerId: t.uuid(),
});
const mine = defineShape("todos.mine", todos, {
  where: ({ userId }) => (userId ? { ownerId: userId } : false),
});
const create = defineMutator({
  name: "todos.create",
  input: z.object({ id: z.uuid(), title: z.string().min(1) }),
  run: async ({ tx, input, userId }) =>
    void (await tx.insert(todos, {
      id: input.id,
      title: input.title,
      ownerId: userId!,
    })),
});
const rename = defineMutator({
  name: "todos.rename",
  input: z.object({ id: z.uuid(), title: z.string() }),
  async run({ tx, input, side, userId }) {
    const todo = await tx.get(todos, input.id);
    if (!todo) throw new MutatorError("not_found", "no such todo");
    if (side === "server" && input.title === "forbidden")
      throw new MutatorError("forbidden", `${userId} may not`);
    await tx.update(todos, input.id, { title: input.title });
  },
});

const UserId = defineService({
  name: "UserId",
  scope: "request",
  inject: { request: CurrentRequest },
  factory: ({ request }) => request.headers.get("x-user") ?? undefined,
});

describe("end to end on Postgres", () => {
  let app: App;
  before(async () => {
    await admin.unsafe(`create schema ${schema}`);
    await sql.unsafe(schemaSql([todos])) // postgresSync installs its change log on first use;
    app = await createApp({
      modules: [
        defineModule({
          name: "auth",
          global: true,
          providers: [UserId],
          exports: [UserId],
        }),
        dataModule({
          sql,
          tables: [todos],
          mutators: [create, rename],
          shapes: [mine],
          sync: postgresSync(sql, { longPoll: 2000 }),
          userId: UserId,
        }),
      ],
      logger: createLogger({ write: () => {} }),
    });
  });
  after(async () => {
    await app?.close();
    await sql.end();
    await admin.unsafe(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  const browser = (user: string) => {
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(new URL(String(input), "http://app.test"), init);
      req.headers.set("x-user", user);
      return app.fetch(req);
    }) as typeof globalThis.fetch;
    const client = createClient({
      transport: electricTransport({ origin: "http://app.test", fetch }),
      mutators: [create, rename],
      userId: () => user,
      fetch,
      confirmTimeout: 5000,
    });
    const view = client.shape(mine);
    const changes: (readonly unknown[])[] = [];
    view.subscribe(() => changes.push(view.rows()));
    return { client, view, changes };
  };
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(check(), what);
  };

  test("a change shows at once, is confirmed by its txid, and reaches the owner's other tabs only", async () => {
    const ann = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const tab1 = browser(ann);
    const tab2 = browser(ann);
    const other = browser(bob);
    try {
      await Promise.all([tab1.view.ready, tab2.view.ready, other.view.ready]);

      tab1.changes.length = 0;
      const id = crypto.randomUUID();
      const m = tab1.client.mutate(create, { id, title: "Buy milk" });
      await m.applied;
      assert.deepEqual(
        tab1.view.rows(),
        [{ id, title: "Buy milk", done: false, ownerId: ann }],
        "optimistic",
      );
      await m.done;
      assert.equal(m.status, "confirmed");
      assert.deepEqual(
        tab1.view.rows(),
        [{ id, title: "Buy milk", done: false, ownerId: ann }],
        "confirmed without a flicker",
      );
      assert.ok(
        tab1.changes.every((rows) => rows.length === 1),
        "the row never disappeared on the way",
      );
      await until(
        () => tab2.view.rows().length === 1,
        "the second tab gets it through the stream",
      );
      assert.deepEqual(
        other.view.rows(),
        [],
        "bob's shape doesn't include ann's todo",
      );

      const bad = tab1.client.mutate(rename, { id, title: "forbidden" });
      await bad.applied;
      assert.equal(
        (tab1.view.rows()[0] as { title: string }).title,
        "forbidden",
        "optimistic rename",
      );
      await assert.rejects(
        bad.done,
        (e) => e instanceof MutationRejected && e.code === "forbidden",
      );
      await until(
        () => (tab1.view.rows()[0] as { title: string }).title === "Buy milk",
        "rolled back",
      );

      await tab2.client.mutate(rename, { id, title: "Buy oat milk" }).done;
      await until(
        () =>
          (tab1.view.rows()[0] as { title: string }).title === "Buy oat milk",
        "a change from the other tab arrives",
      );
    } finally {
      for (const b of [tab1, tab2, other]) b.client.close()
      // Let aborted long-polls finish before the app and the database close.
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});

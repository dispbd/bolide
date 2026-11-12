# @bolide/queue

Background jobs and cron schedules for Bolide apps. Jobs have typed, validated payloads and injected services; a worker runs them inside the app with retries, timeouts and a graceful stop. Messages live in memory (development, tests) or in a Postgres table (production, several instances).

```ts
import { createApp } from '@bolide/core'
import { defineJob, defineSchedule, postgresQueue, Queue, queueModule } from '@bolide/queue'
import { z } from 'zod'

const SendWelcome = defineJob({
  name: 'send-welcome',
  schema: z.object({ userId: z.string() }),
  inject: { users: Users, mailer: Mailer },
  retries: 5,
  handler: async ({ userId }, { users, mailer }, { signal, log }) => {
    log.info('sending welcome')
    await mailer.send(welcome(await users.find(userId)), { signal })
  },
})

const Cleanup = defineJob({ name: 'cleanup', inject: { db: Db }, handler: (_p, { db }) => db.deleteExpired() })

const queue = queueModule({
  jobs: [SendWelcome, Cleanup],
  schedules: [defineSchedule({ cron: '0 3 * * *', job: Cleanup })],
  driver: postgresQueue(sql),
  imports: [usersModule, mailModule],
})

// anywhere: inject Queue
await queue.enqueue(SendWelcome, { userId: '42' }, { delay: '10m' })
```

## Jobs

- `name` is how stored messages find their handler, so keep it stable across deploys.
- `schema` (any Standard Schema) validates the payload when it is enqueued (the caller gets a `ValidationError`) and again before it runs. A job without a schema takes no payload.
- `inject` takes singleton services. They must be visible to the queue module: export them and pass their modules in `imports`, or make those modules global. A mistake fails at boot.
- `retries` (default 3), `backoff` (a `Duration` or `(attempt) => Duration`; default 1s, 2s, 4s... up to 1h), `timeout` (default 5m; the run is aborted through `ctx.signal` and counts as a failure; pass the signal on, because a handler that ignores it keeps its worker slot until it returns).
- After the last attempt the message is kept as `dead` with its error. A payload the current schema rejects goes straight to `dead`.

Jobs run at least once: a message is leased while it runs, and if the process dies it becomes due again when the lease ends. Make handlers idempotent, or enqueue with `{ key }`.

## Enqueueing

`queue.enqueue(job, payload, { delay, runAt, key })` returns the message id. A `key` makes it idempotent: the same key again returns `undefined` and adds nothing while the first message is kept (`keepDone`, default 1 day after it finishes).

## Schedules

`defineSchedule({ cron, job, payload, name })` enqueues the job at each matching minute, in UTC. The parser takes five fields with `*`, ranges, lists, steps, month and day names, and `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`. Every instance can run the scheduler: each slot is enqueued with a key, so it runs once.

## Options

`queueModule({ jobs, schedules, driver, imports, worker, scheduler, concurrency, pollInterval, keepDone, shutdownTimeout })`:

- `worker: false` for processes that only enqueue (the scheduler follows `worker` unless set).
- `concurrency` (default 4) jobs at once per process; `pollInterval` (default 1s) for messages enqueued by other processes or due later.
- `app.close()` stops taking messages and waits up to `shutdownTimeout` (default 30s) for running jobs, then aborts them.

## Drivers

| Driver | Use |
|---|---|
| `memoryQueue()` (default) | One process, tests. `messages()` lists every message with status, attempts and error. |
| `postgresQueue(sql, { table })` | Durable and shared by many workers (`FOR UPDATE SKIP LOCKED`). Takes a postgres.js client (anything with `unsafe(query, params)`); creates its table (`bolide_jobs`) on start. |

## Testing

```ts
const driver = memoryQueue()
const app = await createApp({ modules: [queueModule({ jobs: [SendWelcome], driver, imports: [...] })] })
await app.get(Queue).enqueue(SendWelcome, { userId: '1' })
await app.get(Queue).idle() // until nothing is due or running
assert.equal(driver.messages('send-welcome')[0].status, 'done')
```

Or keep the app's module and swap the driver: `override(QueueDriver, { useValue: memoryQueue() })`.

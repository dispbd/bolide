// Compile-time checks only: `npm run typecheck` fails if inference regresses.
import { defineService } from '../src/service.ts'
import type { InstanceOf } from '../src/service.ts'
import { override } from '../src/container.ts'

const Db = defineService({ name: 'Db', factory: () => ({ query: (sql: string) => [sql] }) })
const Users = defineService({
  name: 'Users',
  inject: { db: Db },
  factory: ({ db }) => {
    db.query('select 1')
    // @ts-expect-error unknown method on an injected service
    db.nope()
    return { count: () => 1 }
  },
})

const users = null as unknown as InstanceOf<typeof Users>
const n: number = users.count()
void n
// @ts-expect-error the instance type is inferred from the factory
users.missing()

// @ts-expect-error an override must match the original instance type
override(Users, { useValue: { count: () => 'not a number' } })

defineService({
  name: 'Bad',
  inject: { db: Db },
  // @ts-expect-error a dependency that is not declared in inject
  factory: ({ cache }) => cache,
})

// Route handlers get typed input from their schemas and typed deps from inject.
import { z } from 'zod'
import { defineRoute } from '../src/route.ts'

defineRoute({
  method: 'POST',
  path: '/users/:id',
  params: z.object({ id: z.string() }),
  body: z.object({ age: z.number() }),
  inject: { users: Users },
  handler: ({ params, body, query }, { users }) => {
    const id: string = params.id
    const age: number = body.age
    const q: string | undefined = query.anything
    users.count()
    // @ts-expect-error body field not in the schema
    body.name
    return { id, age, q }
  },
})

// Without a body schema the body is not read, so it is typed as undefined.
defineRoute({
  method: 'POST',
  path: '/raw',
  handler: ({ body }) => {
    const none: undefined = body
    // @ts-expect-error no body schema, no body fields
    body.anything
    return none
  },
})

defineRoute({
  method: 'GET',
  path: '/x',
  inject: { users: Users },
  // @ts-expect-error dependency not declared in inject
  handler: (_ctx, { db }) => db,
})

// Config values are typed from the schema.
import { defineConfig } from '../src/config.ts'
const Cfg = defineConfig({ name: 'Cfg', schema: z.object({ port: z.coerce.number() }) })
const cfg = null as unknown as InstanceOf<typeof Cfg>
const port: number = cfg.port
void port
// @ts-expect-error configs are read-only
cfg.port = 1

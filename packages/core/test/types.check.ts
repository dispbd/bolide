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

// With a response schema, plain return values must match it; a Response is always fine.
defineRoute({
  method: 'GET',
  path: '/typed',
  response: z.object({ id: z.string() }),
  handler: () => ({ id: 'a' }),
})
defineRoute({
  method: 'GET',
  path: '/typed-async',
  response: z.object({ id: z.string() }),
  handler: async () => new Response('raw'),
})
defineRoute({
  method: 'GET',
  path: '/typed-bad',
  response: z.object({ id: z.string() }),
  // @ts-expect-error id must be a string
  handler: () => ({ id: 1 }),
})
defineRoute({
  method: 'POST',
  path: '/created',
  // @ts-expect-error only 200, 201 and 202 are success statuses for plain values
  status: 204,
  handler: () => 1,
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

// Without schemas, params and query are plain string records.
defineRoute({
  method: 'GET',
  path: '/plain/:id',
  handler: ({ params, query }) => {
    const id: string | undefined = params.id
    const q: string | undefined = query.q
    // @ts-expect-error values are strings
    const n: number = params.id
    return { id, q, n }
  },
})

// A query schema types the query, including coercion and defaults.
defineRoute({
  method: 'GET',
  path: '/search',
  query: z.object({ q: z.string(), limit: z.coerce.number().default(10) }),
  handler: ({ query }) => {
    const limit: number = query.limit
    // @ts-expect-error not in the schema
    query.other
    return { q: query.q, limit }
  },
})

// defineValue infers its type from the value.
import { defineValue } from '../src/service.ts'
const Flags = defineValue('Flags', { beta: true })
const flags = null as unknown as InstanceOf<typeof Flags>
const beta: boolean = flags.beta
void beta
// @ts-expect-error unknown flag
flags.gamma

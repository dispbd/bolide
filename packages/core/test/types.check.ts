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

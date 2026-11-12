import { BolideError, defineModule, defineRoute, defineService, defineValue, HttpError, Log, type AnyService, type Deps, type Module, type Resolved, type Service } from '@bolide/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { checkInput, MutatorError, type AnyMutator, type MutatorContext } from '../mutator.ts'
import type { AnyTable } from '../table.ts'
import type { SqlClient } from './migrate.ts'
import { postgresTx } from './pg-tx.ts'

/** A mutator whose server run is replaced by one with injected services (mail, payments, secrets). */
export interface ServerMutator<M extends AnyMutator = AnyMutator, D extends Deps = Deps> {
  readonly kind: 'server-mutator'
  readonly mutator: M
  readonly inject: D
  run(ctx: MutatorContext<StandardSchemaV1.InferOutput<M['input']>>, deps: Resolved<D>): Promise<void> | void
}

/**
 * Gives a shared mutator a server-only body with injected services. The browser keeps running the shared one
 * optimistically; this file stays on the server, so its imports never reach the bundle.
 *
 * ```ts
 * export const placeOrderOnServer = onServer(placeOrder, {
 *   inject: { payments: Payments },
 *   async run({ tx, input, userId }, { payments }) { ... },
 * })
 * ```
 */
export function onServer<M extends AnyMutator, D extends Deps = {}>(
  mutator: M,
  options: { inject?: D; run: (ctx: MutatorContext<StandardSchemaV1.InferOutput<M['input']>>, deps: Resolved<D>) => Promise<void> | void },
): ServerMutator<M, D> {
  return Object.freeze({ kind: 'server-mutator', mutator, inject: options.inject ?? ({} as D), run: options.run })
}

export interface DataModuleOptions {
  /** A postgres.js client (or anything with `unsafe` and `begin`). A token works too, to share the app's client. */
  sql: SqlClient | Service<SqlClient, any>
  tables: readonly AnyTable[]
  mutators: readonly (AnyMutator | ServerMutator)[]
  /**
   * A request-scoped service that gives the signed-in user's id, or undefined. Mutators get it as `userId`.
   * Without it, every mutation runs with `userId: undefined`.
   */
  userId?: Service<string | undefined, any>
  /** Where the routes live. Default `/api/data`: `POST /api/data/mutate`. */
  prefix?: string
}

const status: Record<MutatorError['code'], number> = { invalid_input: 400, forbidden: 403, not_found: 404, conflict: 409 }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface MutationRequest {
  /** A uuid the browser picks; sending it again doesn't apply the change twice. */
  id: string
  name: string
  input?: unknown
}

const mutationRequest: StandardSchemaV1<MutationRequest> = {
  '~standard': {
    version: 1,
    vendor: 'bolide',
    validate: (v) => {
      const o = v as Partial<MutationRequest> | null
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return { issues: [{ message: 'expected { id, name, input }' }] }
      const issues: StandardSchemaV1.Issue[] = []
      if (typeof o.id !== 'string' || !uuid.test(o.id)) issues.push({ message: 'expected a uuid', path: ['id'] })
      if (typeof o.name !== 'string') issues.push({ message: 'expected a mutator name', path: ['name'] })
      return issues.length ? { issues } : { value: { id: o.id!, name: o.name!, input: o.input } }
    },
  },
}

const NoUser = defineService({ name: 'no user', factory: (): string | undefined => undefined })

/**
 * The server half of the data layer: `POST {prefix}/mutate` runs a mutator in a Postgres transaction and
 * answers `{ txid }`, which the browser waits for on the sync stream before it drops its optimistic copy.
 */
export function dataModule(options: DataModuleOptions): Module {
  const tables = new Set(options.tables)
  const byTableName = new Map<string, AnyTable>()
  for (const t of options.tables) {
    if (byTableName.has(t.name)) throw new BolideError(`dataModule: two tables are named "${t.name}".`)
    byTableName.set(t.name, t)
  }
  const entries = new Map<string, { mutator: AnyMutator; server?: ServerMutator }>()
  for (const m of options.mutators) {
    const mutator = m.kind === 'server-mutator' ? m.mutator : m
    if (entries.has(mutator.name)) throw new BolideError(`dataModule: two mutators are named "${mutator.name}". Pass either the mutator or its onServer() version, once.`)
    entries.set(mutator.name, m.kind === 'server-mutator' ? { mutator, server: m } : { mutator })
  }
  const prefix = (options.prefix ?? '/api/data').replace(/\/$/, '')
  if (!prefix.startsWith('/')) throw new BolideError(`dataModule prefix must start with "/", got "${options.prefix}".`)

  const given = (options.sql as { kind?: unknown }).kind === 'service'
  const sqlToken: Service<SqlClient, any> = given ? (options.sql as Service<SqlClient, any>) : defineValue('data sql', options.sql as SqlClient)
  // One service per server mutator gathers its deps, so the container checks them at boot.
  const serverDeps: Record<string, AnyService> = {}
  for (const [name, e] of entries) if (e.server) serverDeps[name] = defineService({ name: `mutator "${name}"`, inject: e.server.inject, factory: (d) => d })
  const allDeps = defineService({ name: 'data mutators', inject: serverDeps, factory: (d) => d as Record<string, Record<string, unknown>> })

  const Setup = defineService({
    name: 'data setup',
    inject: { sql: sqlToken },
    factory: ({ sql }) => sql,
    // Idempotency records: one row per applied mutation id, with its txid.
    onInit: async (sql) => {
      await sql.unsafe(`create table if not exists bolide_mutations (id uuid primary key, name text not null, txid text, created_at timestamptz not null default now())`)
    },
  })

  const mutate = defineRoute({
    method: 'POST',
    path: `${prefix}/mutate`,
    body: mutationRequest,
    inject: { sql: Setup, userId: options.userId ?? NoUser, deps: allDeps, log: Log },
    handler: async ({ body }, { sql, userId, deps, log }) => {
      const entry = entries.get(body.name)
      if (!entry) throw new HttpError(404, `no mutator "${body.name}"`, undefined, 'unknown_mutator')
      try {
        const input = await checkInput(entry.mutator, body.input)
        const txid = await sql.begin(async (tx) => {
          // A repeat of an applied mutation waits here for the first one to commit, then gets its txid.
          const fresh = await tx.unsafe(`insert into bolide_mutations (id, name) values ($1, $2) on conflict (id) do nothing returning id`, [body.id, body.name])
          if (!fresh.length) {
            const [done] = await tx.unsafe(`select name, txid from bolide_mutations where id = $1`, [body.id])
            if (done?.name !== body.name) throw new MutatorError('conflict', `mutation id ${body.id} was already used by "${String(done?.name)}".`)
            return String(done.txid)
          }
          const ctx = { tx: postgresTx(tx, tables), input, side: 'server' as const, userId }
          if (entry.server) await entry.server.run(ctx, deps[body.name] as never)
          else await entry.mutator.run(ctx)
          const [{ txid }] = (await tx.unsafe(`select pg_current_xact_id()::xid::text as txid`)) as [{ txid: string }]
          await tx.unsafe(`update bolide_mutations set txid = $2 where id = $1`, [body.id, txid])
          return txid
        })
        return { txid }
      } catch (e) {
        if (e instanceof MutatorError) {
          log.debug('mutation rejected', { mutator: body.name, code: e.code, message: e.message })
          throw new HttpError(status[e.code], e.message, undefined, e.code)
        }
        throw e
      }
    },
  })

  const providers: AnyService[] = [Setup, allDeps, ...Object.values(serverDeps), ...(given ? [] : [sqlToken]), ...(options.userId ? [] : [NoUser])]
  return defineModule({ name: 'data', providers, routes: [mutate] })
}

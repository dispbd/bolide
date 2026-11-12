import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { AnyTable, Insert, Patch, Row } from './table.ts'

/**
 * Data access inside a mutator. The same mutator runs twice: in the browser against the local store
 * (optimistic), then on the server in a database transaction (authoritative).
 */
export interface MutatorTx {
  get<T extends AnyTable>(table: T, id: Row<T>[T['primaryKey']]): Promise<Row<T> | undefined>
  /** Inserts a row; columns with defaults may be left out. Returns the full row. */
  insert<T extends AnyTable>(table: T, row: Insert<T>): Promise<Row<T>>
  update<T extends AnyTable>(table: T, id: Row<T>[T['primaryKey']], patch: Patch<T>): Promise<void>
  delete<T extends AnyTable>(table: T, id: Row<T>[T['primaryKey']]): Promise<void>
}

export interface MutatorContext<I> {
  tx: MutatorTx
  input: I
  /** `'client'` for the optimistic run in the browser, `'server'` for the real one. */
  side: 'client' | 'server'
  /** The signed-in user's id. Set on the server; in the browser it is whatever the client was given, so never trust it for permissions there. */
  userId: string | undefined
}

export interface Mutator<N extends string = string, S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly kind: 'mutator'
  readonly name: N
  readonly input: S
  /** False for mutators that only make sense on the server: the browser sends them without an optimistic run. */
  readonly local: boolean
  run(ctx: MutatorContext<StandardSchemaV1.InferOutput<S>>): Promise<void> | void
}

export type AnyMutator = Mutator<string, any>
/** What `mutate(mutator, input)` takes. */
export type MutatorInput<M extends AnyMutator> = StandardSchemaV1.InferInput<M['input']>

export interface MutatorOptions<N extends string, S extends StandardSchemaV1> {
  /** Unique, stable across deploys: the browser sends it. `'todos.toggle'`. */
  name: N
  /** Checked in the browser before the optimistic run, and again on the server. */
  input: S
  run(ctx: MutatorContext<StandardSchemaV1.InferOutput<S>>): Promise<void> | void
  /** Default true. Set false when the browser can't run it (rows it hasn't synced, secrets): it then waits for the server. */
  local?: boolean
}

const mutatorName = /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/

/**
 * A change to data, written once for the browser and the server.
 *
 * ```ts
 * export const toggle = defineMutator({
 *   name: 'todos.toggle',
 *   input: v.object({ id: v.string() }),
 *   async run({ tx, input }) {
 *     const todo = await tx.get(todos, input.id)
 *     if (!todo) throw new MutatorError('not_found', 'no such todo')
 *     await tx.update(todos, input.id, { done: !todo.done })
 *   },
 * })
 * ```
 */
export function defineMutator<const N extends string, S extends StandardSchemaV1>(options: MutatorOptions<N, S>): Mutator<N, S> {
  if (!mutatorName.test(options.name)) throw new TypeError(`mutator name "${options.name}" must be dotted words like "todos.toggle".`)
  if (!options.input || typeof options.input['~standard']?.validate !== 'function') throw new TypeError(`mutator "${options.name}" needs an input schema (any Standard Schema, e.g. from zod or valibot).`)
  return Object.freeze({ kind: 'mutator', name: options.name, input: options.input, local: options.local ?? true, run: options.run })
}

export type MutatorErrorCode = 'invalid_input' | 'not_found' | 'forbidden' | 'conflict'

/** Throw from a mutator to reject the change. The browser rolls back its optimistic run and gets this code. */
export class MutatorError extends Error {
  override name = 'MutatorError'
  constructor(
    readonly code: MutatorErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Checks a mutator's input; a mismatch is a `MutatorError` with code `invalid_input`. */
export async function checkInput<M extends AnyMutator>(mutator: M, value: unknown): Promise<StandardSchemaV1.InferOutput<M['input']>> {
  const result = await mutator.input['~standard'].validate(value)
  if (result.issues) {
    const issues = result.issues.map((i: StandardSchemaV1.Issue) => {
      const path = i.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.')
      return path ? `${path}: ${i.message}` : i.message
    })
    throw new MutatorError('invalid_input', `${mutator.name}: ${issues.join('; ')}`)
  }
  return result.value
}

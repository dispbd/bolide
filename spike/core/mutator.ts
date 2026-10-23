import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Row = Record<string, unknown> & { id: string }

/**
 * Data access a mutator sees. The same mutator runs twice:
 * on the client against the local store (optimistic), and on the
 * server inside a database transaction (authoritative).
 */
export interface MutatorTx {
  readonly side: 'client' | 'server'
  get<T extends Row = Row>(table: string, id: string): Promise<T | undefined>
  insert(table: string, row: Row): Promise<void>
  update(table: string, id: string, patch: Record<string, unknown>): Promise<void>
  delete(table: string, id: string): Promise<void>
}

export interface MutatorContext<I> {
  tx: MutatorTx
  input: I
  /** Present only on the server. The client never knows who it "really" is. */
  userId?: string
}

export interface Mutator<S extends StandardSchemaV1 = StandardSchemaV1, N extends string = string> {
  name: N
  input: S
  run(ctx: MutatorContext<StandardSchemaV1.InferOutput<S>>): Promise<void> | void
}

export function defineMutator<const N extends string, S extends StandardSchemaV1>(def: Mutator<S, N>): Mutator<S, N> {
  return def
}

export type MutatorRegistry = Record<string, Mutator<any, string>>

/** Builds a name-keyed registry that keeps each mutator's literal name and input type. */
export function mutatorRegistry<const T extends Mutator<any, string>[]>(...list: T): { [M in T[number] as M['name']]: M } {
  return Object.fromEntries(list.map((m) => [m.name, m])) as any
}

export class MutatorError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid_input' | 'forbidden' | 'conflict',
  ) {
    super(message)
  }
}

export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema['~standard'].validate(value)
  if (result.issues) {
    throw new MutatorError(result.issues.map((i) => i.message).join('; '), 'invalid_input')
  }
  return result.value
}

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Issue } from './errors.ts'

export type { StandardSchemaV1 }
export type Infer<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : undefined

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

/** Validates a value against any Standard Schema library (zod, valibot, arktype...). */
export async function parse<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<ParseResult<StandardSchemaV1.InferOutput<S>>> {
  const result = await schema['~standard'].validate(value)
  if (!result.issues) return { ok: true, value: result.value }
  return {
    ok: false,
    issues: result.issues.map((i) => ({
      message: i.message,
      path: (i.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)).join('.'),
    })),
  }
}

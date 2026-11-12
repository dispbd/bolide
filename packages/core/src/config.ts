import { BolideError, ConfigError } from './errors.ts'
import { parse, type StandardSchemaV1 } from './schema.ts'
import { defineService, type Service } from './service.ts'

export type Env = Readonly<Record<string, string | undefined>>

/** Environment variables. `createApp({ env })` sets them; defaults to `process.env` where it exists. */
export const AppEnv = defineService<Env>({
  name: 'AppEnv',
  factory: () => {
    throw new BolideError('AppEnv is provided by createApp().')
  },
})

export interface ConfigOptions<S extends StandardSchemaV1> {
  name: string
  schema: S
  /** Builds the raw input for the schema. Defaults to the whole env. */
  load?: (env: Env) => unknown
}

/**
 * A typed, validated config section. It is a regular service: provide it in
 * a module and inject it. An invalid config stops the app at boot with every
 * problem listed.
 *
 * ```ts
 * const DbConfig = defineConfig({
 *   name: 'DbConfig',
 *   schema: z.object({ url: z.url(), pool: z.coerce.number().default(10) }),
 *   load: (env) => ({ url: env.DATABASE_URL, pool: env.DB_POOL }),
 * })
 * ```
 */
export function defineConfig<S extends StandardSchemaV1>(
  options: ConfigOptions<S>,
): Service<Readonly<StandardSchemaV1.InferOutput<S>>, { env: typeof AppEnv }> {
  return defineService({
    name: options.name,
    inject: { env: AppEnv },
    factory: async ({ env }) => {
      const result = await parse(options.schema, (options.load ?? ((e) => e))(env))
      if (!result.ok) throw new ConfigError(options.name, result.issues)
      const value = result.value
      return typeof value === 'object' && value !== null ? Object.freeze(value) : value
    },
  })
}

export function processEnv(): Env {
  const p = (globalThis as { process?: { env?: Env } }).process
  return p?.env ?? {}
}

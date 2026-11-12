import { BolideError, toMs, type Deps, type Duration, type Infer, type Logger, type Resolved, type StandardSchemaV1 } from '@bolide/core'

export interface JobContext {
  /** The message id. */
  id: string
  /** 1 on the first run. */
  attempt: number
  maxAttempts: number
  /** Aborted when the job runs past its `timeout` or the app shuts down. */
  signal: AbortSignal
  /** The app logger with the job name, message id and attempt. */
  log: Logger
}

export interface Job<S extends StandardSchemaV1 | undefined = any, D extends Deps = any> {
  readonly kind: 'job'
  readonly name: string
  readonly schema: S
  readonly inject: D
  /** Runs after the first failure: 3 means up to 4 attempts. */
  readonly retries: number
  /** Milliseconds to wait before attempt `attempt + 1`. */
  backoff(attempt: number): number
  /** Milliseconds before the run is aborted and counted as failed. Also the lease on the message. */
  readonly timeout: number
  // Method syntax keeps every job assignable to AnyJob.
  handler(payload: Infer<S>, deps: Resolved<D>, ctx: JobContext): unknown
}

export type AnyJob = Job<any, any>

/** What `enqueue` takes for a job: the schema's input, or nothing for a job without a schema. */
export type JobInput<J> = J extends Job<infer S, any> ? (S extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S> : undefined) : never

export interface JobOptions<S extends StandardSchemaV1 | undefined, D extends Deps> {
  /** Stable across deploys: stored messages find their handler by it. */
  name: string
  /** Validates the payload when it is enqueued and again before it runs. */
  schema?: S
  /** Singleton services the handler needs. */
  inject?: D
  handler: (payload: Infer<S>, deps: Resolved<D>, ctx: JobContext) => unknown
  /** Default 3. */
  retries?: number
  /** A fixed delay, or one per attempt. Default: 1s, 2s, 4s... capped at 1h. */
  backoff?: Duration | ((attempt: number) => Duration)
  /** Default 5m. */
  timeout?: Duration
}

/**
 * Declares a background job. Register it with `queueModule({ jobs })`, then
 * `queue.enqueue(SendWelcome, { userId })` from anywhere.
 *
 * ```ts
 * const SendWelcome = defineJob({
 *   name: 'send-welcome',
 *   schema: z.object({ userId: z.string() }),
 *   inject: { users: Users, mailer: Mailer },
 *   handler: async ({ userId }, { users, mailer }) => mailer.send(welcome(await users.find(userId))),
 * })
 * ```
 */
export function defineJob<S extends StandardSchemaV1 | undefined = undefined, D extends Deps = {}>(options: JobOptions<S, D>): Job<S, D> {
  const where = `job "${options.name}"`
  if (!options.name) throw new BolideError('a job needs a name.')
  const retries = options.retries ?? 3
  if (!Number.isInteger(retries) || retries < 0) throw new BolideError(`${where}: retries must be a non-negative integer, got ${retries}.`)
  const b = options.backoff
  const backoff =
    b === undefined
      ? (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 3_600_000)
      : typeof b === 'function'
        ? (attempt: number) => toMs(b(attempt), `${where} backoff`)
        : ((ms) => () => ms)(toMs(b, `${where} backoff`))
  const timeout = toMs(options.timeout ?? '5m', `${where} timeout`)
  if (timeout < 1) throw new BolideError(`${where}: timeout must be at least 1ms.`)
  return {
    kind: 'job',
    name: options.name,
    schema: options.schema as S,
    inject: options.inject ?? ({} as D),
    retries,
    backoff,
    timeout,
    handler: options.handler,
  }
}

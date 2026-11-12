import {
  bind,
  BolideError,
  defineModule,
  defineService,
  Log,
  parse,
  toMs,
  ValidationError,
  type AnyService,
  type Duration,
  type Logger,
  type Module,
  type Service,
  type Span,
  Tracer,
} from '@bolide/core'
import { parseCron, type Cron } from './cron.ts'
import { QueueDriver, type QueueMessage } from './driver.ts'
import type { AnyJob, JobInput } from './job.ts'

export interface EnqueueOptions {
  /** Run no earlier than this long from now. */
  delay?: Duration
  /** Run no earlier than this time. */
  runAt?: Date
  /** Idempotency key: enqueueing the same key again does nothing (and returns undefined). */
  key?: string
}

export type EnqueueArgs<J> = undefined extends JobInput<J>
  ? [payload?: JobInput<J>, options?: EnqueueOptions]
  : [payload: JobInput<J>, options?: EnqueueOptions]

export interface Queue {
  /** Validates the payload and stores the message. Returns its id, or undefined for a repeated `key`. */
  enqueue<J extends AnyJob>(job: J, ...args: EnqueueArgs<J>): Promise<string | undefined>
  /**
   * Resolves once this process has no job running and finds nothing due.
   * Messages scheduled for later don't count. Meant for tests and scripts.
   */
  idle(): Promise<void>
}

/** The app's queue. Provide it with `queueModule()`. */
export const Queue = defineService<Queue>({
  name: 'Queue',
  factory: () => {
    throw new BolideError('Queue is provided by queueModule().')
  },
})

export interface Schedule {
  readonly kind: 'schedule'
  readonly name: string
  readonly cron: Cron
  readonly job: AnyJob
  readonly payload: unknown
}

/**
 * Enqueues `job` on a cron schedule (UTC). Every instance may run the scheduler: each run
 * gets an idempotency key, so a slot is enqueued once even with several instances.
 */
export function defineSchedule<J extends AnyJob>(options: { name?: string; cron: string; job: J } & (undefined extends JobInput<J> ? { payload?: JobInput<J> } : { payload: JobInput<J> })): Schedule {
  return { kind: 'schedule', name: options.name ?? options.job.name, cron: parseCron(options.cron), job: options.job, payload: options.payload }
}

export interface QueueModuleOptions {
  jobs: readonly AnyJob[]
  schedules?: readonly Schedule[]
  /** A driver, or a service that builds one. Default: `memoryQueue()`. */
  driver?: QueueDriver | Service<QueueDriver, any>
  /** Modules whose exports the jobs (and a driver service) inject. */
  imports?: readonly Module[]
  /** Run jobs in this process. Turn off for processes that only enqueue. Default true. */
  worker?: boolean
  /** Run the cron schedules in this process. Default: same as `worker`. */
  scheduler?: boolean
  /** Jobs run at once by this process. Default 4. */
  concurrency?: number
  /** How often the worker looks for due messages when nothing woke it. Default 1s. */
  pollInterval?: Duration
  /** How long finished messages (and their idempotency keys) are kept. Default 1d. */
  keepDone?: Duration
  /** How long `app.close()` waits for running jobs before aborting them. Default 30s. */
  shutdownTimeout?: Duration
}

/**
 * A global module providing `Queue`, running a worker and the cron schedules.
 *
 * ```ts
 * queueModule({ jobs: [SendWelcome], schedules: [defineSchedule({ cron: '0 3 * * *', job: Cleanup })], imports: [users] })
 * ```
 */
export function queueModule(options: QueueModuleOptions): Module {
  const jobs = new Map<string, AnyJob>()
  for (const j of options.jobs) {
    if (jobs.has(j.name) && jobs.get(j.name) !== j) throw new BolideError(`two jobs are named "${j.name}". Job names must be unique.`)
    jobs.set(j.name, j)
  }
  const schedules = options.schedules ?? []
  const scheduleNames = new Set<string>()
  for (const s of schedules) {
    if (jobs.get(s.job.name) !== s.job) throw new BolideError(`schedule "${s.name}" runs job "${s.job.name}", which is not in queueModule({ jobs }).`)
    if (scheduleNames.has(s.name)) throw new BolideError(`two schedules are named "${s.name}". Give one a name.`)
    scheduleNames.add(s.name)
  }
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new BolideError(`queueModule concurrency must be a positive integer, got ${concurrency}.`)
  const settings = {
    worker: options.worker ?? true,
    scheduler: options.scheduler ?? options.worker ?? true,
    concurrency,
    pollInterval: toMs(options.pollInterval ?? '1s', 'queueModule pollInterval'),
    keepDone: toMs(options.keepDone ?? '1d', 'queueModule keepDone'),
    shutdownTimeout: toMs(options.shutdownTimeout ?? '30s', 'queueModule shutdownTimeout'),
  }

  // One service per job gathers its deps, so the container checks them at boot like any other.
  const jobDeps: Record<string, AnyService> = {}
  for (const j of jobs.values()) {
    jobDeps[j.name] = defineService({ name: `job "${j.name}"`, inject: j.inject, factory: (deps) => deps })
  }
  const store = options.driver
  const driver =
    store === undefined ? QueueDriver : bind(QueueDriver, typeof store === 'object' && (store as { kind?: unknown }).kind === 'service' ? { useService: store as Service<QueueDriver, any> } : { useValue: store as QueueDriver })

  const allDeps = defineService({ name: 'queue jobs', inject: jobDeps, factory: (d) => d })
  const impl = defineService({
    name: 'Queue',
    inject: { driver: QueueDriver, log: Log, tracer: Tracer, deps: allDeps },
    factory: ({ driver, log, tracer, deps }) => new QueueRuntime(driver, log, tracer, jobs, deps as Record<string, Record<string, unknown>>, schedules, settings),
    onInit: (q) => q.start(),
    onDestroy: (q) => q.stop(),
  })
  return defineModule({
    name: 'queue',
    global: true,
    imports: options.imports,
    providers: [driver, ...Object.values(jobDeps), allDeps, bind(Queue, { useService: impl })],
    exports: [Queue, QueueDriver],
  })
}

interface Settings {
  worker: boolean
  scheduler: boolean
  concurrency: number
  pollInterval: number
  keepDone: number
  shutdownTimeout: number
}

class QueueRuntime implements Queue {
  private readonly names: string[]
  private readonly running = new Map<string, { done: Promise<void>; abort: AbortController }>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly idleWaiters: (() => void)[] = []
  private pumping = false
  private again = false
  private stopped = false

  constructor(
    private readonly driver: QueueDriver,
    private readonly log: Logger,
    private readonly tracer: Tracer,
    private readonly jobs: ReadonlyMap<string, AnyJob>,
    private readonly deps: Record<string, Record<string, unknown>>,
    private readonly schedules: readonly Schedule[],
    private readonly settings: Settings,
  ) {
    this.names = [...jobs.keys()]
  }

  async enqueue<J extends AnyJob>(job: J, ...[payload, options = {}]: EnqueueArgs<J>) {
    if (this.jobs.get(job.name) !== job) throw new BolideError(`job "${job.name}" is not registered. Add it to queueModule({ jobs }).`)
    if (job.schema) {
      const result = await parse(job.schema, payload)
      if (!result.ok) throw new ValidationError(`payload of job "${job.name}"`, result.issues)
    } else if (payload !== undefined) {
      throw new BolideError(`job "${job.name}" has no schema, so it takes no payload. Add a schema to pass data.`)
    }
    const delay = options.delay === undefined ? 0 : toMs(options.delay, 'enqueue delay')
    const runAt = options.runAt ?? new Date(Date.now() + delay)
    const id = await this.driver.push({ job: job.name, payload: JSON.stringify(payload ?? null), runAt, maxAttempts: job.retries + 1, key: options.key })
    if (delay === 0 && runAt.getTime() <= Date.now()) void this.pump()
    return id
  }

  idle() {
    if (!this.settings.worker) return Promise.reject(new BolideError('idle() needs a worker; this process has queueModule({ worker: false }).'))
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
      void this.pump()
    })
  }

  async start() {
    await this.driver.setup?.()
    if (this.settings.worker) {
      this.every(this.settings.pollInterval, () => this.pump())
      if (this.driver.prune) {
        const prune = () => this.driver.prune!(new Date(Date.now() - this.settings.keepDone)).catch((e) => this.log.warn('queue prune failed', { err: e }))
        void prune()
        this.every(3_600_000, prune)
      }
    }
    if (this.settings.scheduler) {
      for (const s of this.schedules) {
        // A bad payload would fail at every slot; fail at boot instead.
        if (s.job.schema) {
          const payload = await parse(s.job.schema, s.payload)
          if (!payload.ok) throw new ValidationError(`payload of schedule "${s.name}"`, payload.issues)
        }
        this.plan(s, s.cron.next(new Date()))
      }
    }
  }

  async stop() {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    const all = [...this.running.values()]
    if (!all.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), this.settings.shutdownTimeout)))
    const outcome = await Promise.race([Promise.all(all.map((r) => r.done)).then(() => 'done' as const), late])
    clearTimeout(timer)
    if (outcome === 'late') {
      this.log.warn('queue: jobs still running at shutdown, aborting them', { jobs: this.running.size })
      for (const r of all) r.abort.abort(new BolideError('the app is shutting down'))
      await Promise.all(all.map((r) => r.done))
    }
  }

  private every(ms: number, fn: () => unknown) {
    const tick = () => {
      this.timers.delete(t)
      if (this.stopped) return
      void fn()
      t = setTimeout(tick, ms)
      this.timers.add(t)
    }
    let t = setTimeout(tick, ms)
    this.timers.add(t)
  }

  /** Waits for the slot (in steps, since timers can't wait more than ~24 days), then enqueues it. */
  private plan(s: Schedule, at: Date) {
    const wait = Math.min(at.getTime() - Date.now(), 3_600_000)
    const t = setTimeout(async () => {
      this.timers.delete(t)
      if (this.stopped) return
      if (Date.now() < at.getTime()) return this.plan(s, at)
      try {
        await this.enqueue(s.job, ...([s.payload, { runAt: at, key: `schedule:${s.name}:${at.toISOString()}` }] as never as []))
      } catch (e) {
        this.log.error('schedule failed to enqueue', { schedule: s.name, at: at.toISOString(), err: e })
      }
      if (!this.stopped) this.plan(s, s.cron.next(at))
    }, Math.max(wait, 0))
    this.timers.add(t)
  }

  /** Reserves due messages up to the concurrency limit. Re-entrant calls just ask for one more pass. */
  private async pump(): Promise<void> {
    if (!this.settings.worker || this.stopped) return
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    let empty = false
    try {
      do {
        this.again = false
        while (!this.stopped && this.running.size < this.settings.concurrency) {
          let msg: QueueMessage | undefined
          try {
            msg = await this.driver.reserve(this.names, this.leaseFor())
          } catch (e) {
            this.log.error('queue reserve failed', { err: e })
            break
          }
          if (!msg) {
            empty = true
            break
          }
          empty = false
          this.launch(msg)
        }
      } while (this.again && !this.stopped)
    } finally {
      this.pumping = false
    }
    if (empty && this.running.size === 0) for (const w of this.idleWaiters.splice(0)) w()
  }

  private leaseFor() {
    let max = 0
    for (const j of this.jobs.values()) max = Math.max(max, j.timeout)
    // A little over the longest timeout, so a live worker always finishes first.
    return max + 5000
  }

  private launch(msg: QueueMessage) {
    const abort = new AbortController()
    const attributes = { 'job.name': msg.job, 'job.id': msg.id, 'job.attempt': msg.attempt }
    const done = this.tracer.span(`job ${msg.job}`, (span) => this.execute(msg, abort, span), { kind: 'consumer', attributes }).finally(() => {
      this.running.delete(msg.id)
      void this.pump()
    })
    this.running.set(msg.id, { done, abort })
  }

  private async execute(msg: QueueMessage, abort: AbortController, span: Span) {
    const job = this.jobs.get(msg.job)!
    const log = this.log.child({ job: msg.job, jobId: msg.id, attempt: msg.attempt })
    const report = (what: string, e: unknown) => log.error(what, { err: e })
    if (msg.attempt > msg.maxAttempts) {
      // Its last worker died mid-run: don't start an attempt the job didn't allow.
      return this.driver.fail(msg.id, 'ran out of attempts (the worker stopped during the last one)').catch((e) => report('queue fail failed', e))
    }
    const timer = setTimeout(() => abort.abort(new BolideError(`job "${job.name}" timed out after ${job.timeout}ms`)), job.timeout)
    const started = performance.now()
    try {
      const input = JSON.parse(msg.payload)
      let payload: unknown = undefined
      if (job.schema) {
        const result = await parse(job.schema, input)
        if (!result.ok) {
          // Retrying can't fix a payload the current schema rejects.
          const e = new ValidationError(`payload of job "${job.name}"`, result.issues)
          span.recordError(e)
          log.error('job payload is invalid, giving up', { err: e })
          return await this.driver.fail(msg.id, e.message)
        }
        payload = result.value
      }
      const aborted = new Promise<never>((_, reject) => {
        if (abort.signal.aborted) reject(abort.signal.reason)
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
      })
      aborted.catch(() => {})
      await Promise.race([
        job.handler(payload, this.deps[job.name] as never, { id: msg.id, attempt: msg.attempt, maxAttempts: msg.maxAttempts, signal: abort.signal, log }),
        aborted,
      ])
      await this.driver.complete(msg.id)
      log.debug('job done', { ms: Math.round(performance.now() - started) })
    } catch (e) {
      span.recordError(e)
      const message = e instanceof Error ? e.message : String(e)
      try {
        if (msg.attempt < msg.maxAttempts) {
          const wait = job.backoff(msg.attempt)
          log.warn('job failed, will retry', { err: e, retryIn: wait })
          await this.driver.retry(msg.id, new Date(Date.now() + wait), message)
          if (wait === 0) void this.pump()
        } else {
          log.error('job failed, giving up', { err: e })
          await this.driver.fail(msg.id, message)
        }
      } catch (e2) {
        report('queue could not record a failure', e2)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

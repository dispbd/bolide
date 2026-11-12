import { defineService } from '@bolide/core'
import { memoryQueue } from './memory.ts'

export interface NewMessage {
  job: string
  /** The payload as JSON. */
  payload: string
  runAt: Date
  maxAttempts: number
  /** Idempotency key: a second message with the same key is dropped while the first is kept. */
  key?: string
}

export interface QueueMessage {
  id: string
  job: string
  payload: string
  /** 1 on the first run. */
  attempt: number
  maxAttempts: number
}

/**
 * Stores messages and hands them to workers. A reserved message is leased: if its worker
 * dies, the message becomes due again when the lease ends, so jobs run at least once.
 */
export interface QueueDriver {
  /** Returns the message id, or undefined when `key` was already used. */
  push(message: NewMessage): Promise<string | undefined>
  /** Claims the oldest due message among `jobs` for `lease` ms and counts the attempt. */
  reserve(jobs: readonly string[], lease: number): Promise<QueueMessage | undefined>
  complete(id: string): Promise<void>
  /** Puts a failed message back to run again at `runAt`. */
  retry(id: string, runAt: Date, error: string): Promise<void>
  /** Gives up on a message. It is kept, marked dead, for inspection. */
  fail(id: string, error: string): Promise<void>
  /** Creates tables and the like. Called once before the worker starts. */
  setup?(): Promise<void>
  /** Removes completed messages finished before `before`. Their idempotency keys are freed with them. */
  prune?(before: Date): Promise<void>
}

/** The driver `Queue` uses: a memory queue unless `queueModule({ driver })` picks another. */
export const QueueDriver = defineService<QueueDriver>({ name: 'QueueDriver', factory: () => memoryQueue() })

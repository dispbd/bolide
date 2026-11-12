import type { AnyShape } from '@bolide/data'

/** One row change from the sync stream. Rows use SQL column names, as the database sends them. */
export type SyncChange =
  | { type: 'insert'; row: Record<string, unknown> }
  /** May hold only the changed columns plus the primary key. */
  | { type: 'update'; row: Record<string, unknown> }
  | { type: 'delete'; row: Record<string, unknown> }

export interface SyncSink {
  /** A batch of changes, with the ids of the transactions that made them. */
  changes(changes: SyncChange[], txids: readonly string[]): void
  /** The stream has caught up with the server: the shape's rows are complete. */
  upToDate(): void
  /** The server asked to start over: drop the rows; a full set follows. */
  reset(): void
  error(e: unknown): void
}

/**
 * Where synced rows come from. Electric is one implementation; tests and the development mode have others.
 * The client never tells a transport what to filter: it names a shape, and the server applies its rule.
 */
export interface SyncTransport {
  /** Starts streaming a shape from `url`. Returns a function that stops it. */
  subscribe(request: { url: string; shape: AnyShape; headers: () => Record<string, string> }, sink: SyncSink): () => void
}

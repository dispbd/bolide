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
  /** Where the stream is, after a batch that ended up to date: saved with the rows to resume after a reload. */
  position?(position: SyncPosition): void
  /** A request failed and is being retried: the server can't be reached right now. */
  offline?(): void
}

/** A point in a shape's stream to resume from (Electric's offset and handle). */
export interface SyncPosition {
  offset: string
  handle: string
}

/**
 * Where synced rows come from. Electric is one implementation; tests and the development mode have others.
 * The client never tells a transport what to filter: it names a shape, and the server applies its rule.
 */
export interface SyncTransport {
  /** Starts streaming a shape from `url`. Returns a function that stops it. */
  subscribe(request: { url: string; shape: AnyShape; headers: () => Record<string, string>; resume?: SyncPosition }, sink: SyncSink): () => void
}

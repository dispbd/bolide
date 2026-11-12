import { isChangeMessage, isControlMessage, ShapeStream, type Message, type Row } from '@electric-sql/client'
import type { SyncChange, SyncTransport } from './transport.ts'

export interface ElectricTransportOptions {
  /** The page's origin is used for relative URLs; set it outside a browser (tests, React Native). */
  origin?: string
  fetch?: typeof fetch
}

/**
 * Syncs shapes with the Electric protocol, through the app's own `/api/data/shape/:name` route.
 * The browser never talks to Electric directly, so the server's read rules always apply.
 */
export function electricTransport(options: ElectricTransportOptions = {}): SyncTransport {
  return {
    subscribe({ url, headers }, sink) {
      const origin = options.origin ?? (typeof location === 'undefined' ? undefined : location.origin)
      const abort = new AbortController()
      const stream = new ShapeStream({
        signal: abort.signal,
        url: origin ? new URL(url, origin).toString() : url,
        headers: headers(),
        ...(options.fetch ? { fetchClient: options.fetch } : {}),
        onError: (e) => {
          if (!abort.signal.aborted) sink.error(e)
        },
      })
      const unsubscribe = stream.subscribe((messages: Message<Row>[]) => {
        const changes: SyncChange[] = []
        const txids = new Set<string>()
        for (const m of messages) {
          if (isChangeMessage(m)) {
            changes.push({ type: m.headers.operation, row: m.value as Record<string, unknown> })
            for (const t of m.headers.txids ?? []) txids.add(String(t))
          } else if (isControlMessage(m)) {
            if (changes.length) sink.changes(changes.splice(0), [...txids])
            if (m.headers.control === 'must-refetch') sink.reset()
            else if (m.headers.control === 'up-to-date') sink.upToDate()
          }
        }
        if (changes.length) sink.changes(changes, [...txids])
      })
      return () => {
        unsubscribe()
        stream.unsubscribeAll()
        // Also ends the long-poll request in flight.
        abort.abort()
      }
    },
  }
}

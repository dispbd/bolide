import { BolideError } from './errors.ts'
import { defineService } from './service.ts'

export type SpanAttributes = Record<string, string | number | boolean>

export interface Span {
  /** The trace id when the tracer has one (for log correlation). */
  readonly traceId?: string
  setAttribute(key: string, value: string | number | boolean): void
  /** Renames the span, e.g. once the route is known. */
  updateName(name: string): void
  /** Records the error and marks the span as failed. */
  recordError(error: unknown): void
}

export interface SpanOptions {
  attributes?: SpanAttributes
  /** Incoming headers to continue a trace from (W3C `traceparent`), for spans that start a request. */
  parent?: Headers
  kind?: 'server' | 'internal' | 'consumer'
}

/**
 * Wraps work in spans. The default does nothing; `otelTracer()` sends spans to OpenTelemetry.
 * Spans nest: a span started inside another's callback is its child.
 */
export interface Tracer {
  /** Runs `fn` in a new span and ends it when `fn` settles. A thrown error is recorded and rethrown. */
  span<T>(name: string, fn: (span: Span) => T | Promise<T>, options?: SpanOptions): Promise<T>
}

const noopSpan: Span = { setAttribute() {}, updateName() {}, recordError() {} }

/** A tracer that only runs the callbacks. */
export const noopTracer: Tracer = { span: async (_name, fn) => fn(noopSpan) }

/** The app's tracer. `createApp({ tracer })` sets it; spans cover requests and, in batteries, jobs. */
export const Tracer = defineService<Tracer>({
  name: 'Tracer',
  factory: () => {
    throw new BolideError('Tracer is provided by createApp().')
  },
})

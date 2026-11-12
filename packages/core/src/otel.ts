import type { Span, SpanOptions, Tracer } from './trace.ts'

// The few parts of `@opentelemetry/api` the adapter uses, typed structurally so the core
// takes no OpenTelemetry dependency. Pass the real module: `otelTracer(api)`.
interface OtelSpan {
  spanContext(): { traceId: string }
  setAttribute(key: string, value: string | number | boolean): unknown
  updateName(name: string): unknown
  recordException(exception: Error | string): unknown
  setStatus(status: { code: number; message?: string }): unknown
  end(): void
}

interface OtelTracer {
  startActiveSpan<F extends (span: OtelSpan) => unknown>(name: string, options: { kind?: number; attributes?: Record<string, unknown> }, context: unknown, fn: F): ReturnType<F>
}

export interface OtelApi {
  trace: { getTracer(name: string, version?: string): OtelTracer }
  context: { active(): unknown }
  propagation: {
    extract(context: unknown, carrier: Headers, getter: { keys(c: Headers): string[]; get(c: Headers, key: string): string | undefined }): unknown
  }
}

const kinds = { internal: 0, server: 1, consumer: 4 } as const
const ERROR = 2

const headerGetter = {
  keys: (h: Headers) => {
    const keys: string[] = []
    h.forEach((_, k) => void keys.push(k))
    return keys
  },
  get: (h: Headers, key: string) => h.get(key) ?? undefined,
}

/**
 * Sends Bolide's spans to OpenTelemetry. Set up the SDK as usual (exporter, context manager),
 * then `createApp({ tracer: otelTracer(api) })` with `import * as api from '@opentelemetry/api'`.
 * Incoming `traceparent` headers continue the caller's trace.
 */
export function otelTracer(api: OtelApi, options: { name?: string } = {}): Tracer {
  const tracer = api.trace.getTracer(options.name ?? 'bolide')
  return {
    span<T>(name: string, fn: (span: Span) => T | Promise<T>, o: SpanOptions = {}): Promise<T> {
      const ctx = o.parent ? api.propagation.extract(api.context.active(), o.parent, headerGetter) : api.context.active()
      return tracer.startActiveSpan(name, { kind: kinds[o.kind ?? 'internal'], attributes: o.attributes }, ctx, async (otel) => {
        const span: Span = {
          traceId: otel.spanContext().traceId,
          setAttribute: (k, v) => void otel.setAttribute(k, v),
          updateName: (n) => void otel.updateName(n),
          recordError: (e) => {
            otel.recordException(e instanceof Error ? e : String(e))
            otel.setStatus({ code: ERROR, message: e instanceof Error ? e.message : String(e) })
          },
        }
        try {
          return await fn(span)
        } catch (e) {
          span.recordError(e)
          throw e
        } finally {
          otel.end()
        }
      })
    },
  }
}

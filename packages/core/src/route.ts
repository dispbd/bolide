import type { Infer, StandardSchemaV1 } from './schema.ts'
import type { Deps, Resolved } from './service.ts'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type Maybe = StandardSchemaV1 | undefined
type Or<S extends Maybe, Fallback> = S extends StandardSchemaV1 ? Infer<S> : Fallback

export interface RouteContext<P extends Maybe, Q extends Maybe, B extends Maybe> {
  /** Path params, validated when `params` has a schema. */
  params: Or<P, Record<string, string>>
  /** Query string, validated when `query` has a schema. Repeated keys keep the last value. */
  query: Or<Q, Record<string, string>>
  /**
   * JSON body, read and validated only when the route has a `body` schema (otherwise `undefined`;
   * use `request` for raw access). Needs a JSON Content-Type (else 415) and fits `bodyLimit` (else 413).
   */
  body: Or<B, undefined>
  request: Request
}

export interface Route<D extends Deps = Deps, P extends Maybe = Maybe, Q extends Maybe = Maybe, B extends Maybe = Maybe> {
  readonly kind: 'route'
  readonly method: Method
  readonly path: string
  readonly inject: D
  readonly params: P
  readonly query: Q
  readonly body: B
  readonly summary?: string
  // Method syntax keeps routes assignable to AnyRoute.
  handler(ctx: RouteContext<P, Q, B>, deps: Resolved<D>): unknown
}

/** Any route, for lists of routes with different types. */
export type AnyRoute = Route<any, any, any, any>

export interface RouteOptions<D extends Deps, P extends Maybe, Q extends Maybe, B extends Maybe> {
  method: Method
  /** Hono-style path, e.g. `/users/:id`. Prefixed by the module's `prefix`. */
  path: string
  inject?: D
  params?: P
  query?: Q
  body?: B
  /** One line for docs and OpenAPI. */
  summary?: string
  /**
   * Return a plain value to send it as JSON (200), `undefined` for 204,
   * or a `Response` for full control. Throw `HttpError` for other statuses.
   */
  handler: (ctx: RouteContext<P, Q, B>, deps: Resolved<D>) => unknown
}

/**
 * ```ts
 * const getUser = defineRoute({
 *   method: 'GET',
 *   path: '/users/:id',
 *   params: z.object({ id: z.uuid() }),
 *   inject: { users: Users },
 *   handler: ({ params }, { users }) => users.find(params.id) ?? notFound(),
 * })
 * ```
 */
export function defineRoute<D extends Deps = {}, P extends Maybe = undefined, Q extends Maybe = undefined, B extends Maybe = undefined>(
  options: RouteOptions<D, P, Q, B>,
): Route<D, P, Q, B> {
  return {
    kind: 'route',
    method: options.method,
    path: options.path,
    inject: options.inject ?? ({} as D),
    params: options.params as P,
    query: options.query as Q,
    body: options.body as B,
    summary: options.summary,
    handler: options.handler,
  }
}

/** A JSON response with a custom status or headers. */
export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const opts = typeof init === 'number' ? { status: init } : init
  const headers = new Headers(opts.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...opts, headers })
}

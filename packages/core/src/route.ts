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

/** What a handler may return: with a `response` schema, values must match it. */
export type HandlerResult<R extends Maybe> = R extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<R> | Response | Promise<StandardSchemaV1.InferInput<R> | Response>
  : unknown

/** Status sent for a plain value returned by the handler. */
export type SuccessStatus = 200 | 201 | 202

export interface Route<D extends Deps = Deps, P extends Maybe = Maybe, Q extends Maybe = Maybe, B extends Maybe = Maybe, R extends Maybe = Maybe> {
  readonly kind: 'route'
  readonly method: Method
  readonly path: string
  readonly inject: D
  readonly params: P
  readonly query: Q
  readonly body: B
  readonly response: R
  readonly status: SuccessStatus
  readonly docs: RouteDocs
  // Method syntax keeps routes assignable to AnyRoute.
  handler(ctx: RouteContext<P, Q, B>, deps: Resolved<D>): HandlerResult<R>
}

/** Any route, for lists of routes with different types. */
export type AnyRoute = Route<any, any, any, any, any>

/** Extra OpenAPI fields for a route. */
export interface RouteDocs {
  /** One line for docs and OpenAPI. */
  summary?: string
  description?: string
  /** Defaults to the module name. */
  tags?: string[]
  /** Defaults to the method plus the path, e.g. `getUsersById`. */
  operationId?: string
  deprecated?: boolean
}

export interface RouteOptions<D extends Deps, P extends Maybe, Q extends Maybe, B extends Maybe, R extends Maybe> extends RouteDocs {
  method: Method
  /** Hono-style path, e.g. `/users/:id`. Prefixed by the module's `prefix`. */
  path: string
  inject?: D
  params?: P
  query?: Q
  body?: B
  /**
   * Schema of the JSON a plain return value becomes. Used for OpenAPI and to type the
   * handler's return value; it is not checked at runtime.
   */
  response?: R
  /** Status for a plain return value. Default 200. */
  status?: SuccessStatus
  /**
   * Return a plain value to send it as JSON (`status`, default 200), `undefined` for 204,
   * or a `Response` for full control. Throw `HttpError` for error statuses.
   */
  handler: (ctx: RouteContext<P, Q, B>, deps: Resolved<D>) => HandlerResult<R>
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
export function defineRoute<
  D extends Deps = {},
  P extends Maybe = undefined,
  Q extends Maybe = undefined,
  B extends Maybe = undefined,
  R extends Maybe = undefined,
>(options: RouteOptions<D, P, Q, B, R>): Route<D, P, Q, B, R> {
  return {
    kind: 'route',
    method: options.method,
    path: options.path,
    inject: options.inject ?? ({} as D),
    params: options.params as P,
    query: options.query as Q,
    body: options.body as B,
    response: options.response as R,
    status: options.status ?? 200,
    docs: {
      summary: options.summary,
      description: options.description,
      tags: options.tags,
      operationId: options.operationId,
      deprecated: options.deprecated,
    },
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

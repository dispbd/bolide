import type { Method } from './route.ts'
import type { Deps, Resolved } from './service.ts'

/** What middleware and guards know about the request. `route` is unset for app-wide middleware. */
export interface MiddlewareContext {
  request: Request
  /** The matched route; only set for module and route middleware, which run after routing. */
  route?: { method: Method; path: string; module: string }
}

export interface Middleware<D extends Deps = Deps> {
  readonly kind: 'middleware'
  readonly name: string
  readonly inject: D
  // Method syntax keeps middleware assignable to AnyMiddleware.
  handle(ctx: MiddlewareContext, next: () => Promise<Response>, deps: Resolved<D>): Response | Promise<Response>
}

export interface Guard<D extends Deps = Deps> {
  readonly kind: 'guard'
  readonly name: string
  readonly inject: D
  check(ctx: MiddlewareContext, deps: Resolved<D>): boolean | Promise<boolean>
}

/** Anything accepted by `use` on an app, a module or a route. */
export type Use = Middleware<any> | Guard<any>

/**
 * Wraps request handling. Call `next()` to continue and get the response, or
 * return a response without calling it. Deps are resolved per request, so
 * request-scoped services (and `CurrentRequest`) can be injected.
 *
 * ```ts
 * const timing = defineMiddleware({
 *   name: 'timing',
 *   handle: async (_ctx, next) => {
 *     const start = performance.now()
 *     const res = await next()
 *     res.headers.set('server-timing', `app;dur=${performance.now() - start}`)
 *     return res
 *   },
 * })
 * ```
 */
export function defineMiddleware<D extends Deps = {}>(options: {
  name: string
  inject?: D
  handle: (ctx: MiddlewareContext, next: () => Promise<Response>, deps: Resolved<D>) => Response | Promise<Response>
}): Middleware<D> {
  return { kind: 'middleware', name: options.name, inject: options.inject ?? ({} as D), handle: options.handle }
}

/**
 * Allows or denies a request before input is parsed. Returning false sends 403;
 * throw an `HttpError` for another status (e.g. 401 when nobody is signed in).
 */
export function defineGuard<D extends Deps = {}>(options: {
  name: string
  inject?: D
  check: (ctx: MiddlewareContext, deps: Resolved<D>) => boolean | Promise<boolean>
}): Guard<D> {
  return { kind: 'guard', name: options.name, inject: options.inject ?? ({} as D), check: options.check }
}

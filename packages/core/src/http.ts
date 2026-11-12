import { Hono } from 'hono'
import type { Container, RequestScope } from './container.ts'
import { BolideError, HttpError, ValidationError } from './errors.ts'
import type { MiddlewareContext, Use } from './middleware.ts'
import type { Module } from './module.ts'
import type { AnyRoute, Method } from './route.ts'
import { RequestId, type Logger } from './log.ts'
import type { Span, Tracer } from './trace.ts'
import { parse, type StandardSchemaV1 } from './schema.ts'
import { defineService, type AnyService } from './service.ts'

/** The current `Request`. Inject it into request-scoped services. */
export const CurrentRequest = defineService<Request>({
  name: 'CurrentRequest',
  scope: 'request',
  factory: () => {
    throw new BolideError('CurrentRequest is only available while handling a request.')
  },
})

export interface RouteInfo {
  method: Method
  path: string
  module: string
  route: AnyRoute
}

/** Gets every unexpected error (the client sees a plain 500), with the id of the request it happened in. */
export type ErrorReporter = (error: unknown, request: Request, info: { requestId: string }) => void

/** What the route handler tells the app-level wrapper about a request, for the access log. */
interface RequestEnv {
  scope: RequestScope
  report: (error: unknown, request: Request) => void
  matched: { route?: string }
}

/**
 * Turns the modules' routes into a Hono app. Hono stays an implementation
 * detail (ADR 0001): user code only sees Request, Response and our types.
 */
export interface HttpOptions {
  /** Max request body size in bytes for routes with a `body` schema. Larger bodies get 413. */
  bodyLimit: number
  /** App-wide middleware and guards: they run for every request, before routing. */
  use?: readonly Use[]
  /** Answers some requests before routing (the OpenAPI document), still inside app middleware. */
  prelude?: (routes: readonly RouteInfo[]) => (request: Request) => Response | undefined
  /** Writes one line per request to this logger when set. */
  accessLog?: () => Logger
  /** Wraps each request in a server span. */
  tracer?: () => Tracer
}

export function buildHttp(container: Container, modules: readonly Module[], onError: ErrorReporter, options: HttpOptions) {
  const hono = new Hono()
  const routes: RouteInfo[] = []
  const seen = new Map<string, { module: string; path: string }>()

  for (const m of modules) {
    for (const route of m.routes) {
      const path = joinPath(m.prefix, route.path)
      // Param names don't matter to the router: /users/:id and /users/:userId clash.
      // Regex constraints and `?` do, so /:id{[0-9]+} and /:slug{[a-z]+} don't.
      const key = `${route.method} ${path.replace(/\/:[^/{?]+/g, '/:')}`
      const clash = seen.get(key)
      if (clash) {
        const where = clash.module === m.name ? `twice in "${m.name}"` : `in both "${clash.module}" and "${m.name}"`
        throw new BolideError(`route ${route.method} ${path} clashes with ${route.method} ${clash.path}: defined ${where}.`)
      }
      seen.set(key, { module: m.name, path })
      routes.push({ method: route.method, path, module: m.name, route })

      const uses = [...m.use, ...route.use]
      const info = { method: route.method, path, module: m.name }
      hono.on(route.method, path, async (c) => {
        const request = c.req.raw
        const { scope, report, matched } = c.env as RequestEnv
        matched.route = path
        // The handler's errors become responses here, so middleware always sees a Response.
        const handle = async () => {
          try {
            const ctx = {
              params: await input('params', route.params, c.req.param()),
              query: await input('query', route.query, c.req.query()),
              body: route.body ? await input('body', route.body, await readJson(request, options.bodyLimit)) : undefined,
              request,
            }
            const deps = await scope.resolveAll(route.inject)
            return toResponse(await route.handler(ctx as never, deps), route.status)
          } catch (e) {
            return errorResponse(e, request, report)
          }
        }
        try {
          return await runChain(uses, { request, route: info }, scope, report, handle)
        } catch (e) {
          return errorResponse(e, request, report)
        }
      })
    }
  }

  hono.notFound((c) => Response.json({ error: 'not_found', message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` }, { status: 404 }))

  const prelude = options.prelude?.(routes)
  const appUse = options.use ?? []
  const access = options.accessLog
  const fetch = (request: Request) => {
    const path = new URL(request.url).pathname
    if (!options.tracer) return serve(request, path)
    return options.tracer().span(request.method, (span) => serve(request, path, span), {
      kind: 'server',
      parent: request.headers,
      attributes: { 'http.request.method': request.method, 'url.path': path },
    })
  }
  const serve = async (request: Request, path: string, span?: Span) => {
    const started = performance.now()
    const requestId = incomingId(request.headers.get('x-request-id')) ?? crypto.randomUUID()
    const report = (e: unknown, r: Request) => {
      span?.recordError(e)
      onError(e, r, { requestId })
    }
    const matched: RequestEnv['matched'] = {}
    const scope = container.createScope(
      new Map<AnyService, unknown>([
        [CurrentRequest, request],
        [RequestId, requestId],
      ]),
    )
    let res: Response
    try {
      const env: RequestEnv = { scope, report, matched }
      res = await runChain(appUse, { request }, scope, report, async () => prelude?.(request) ?? (await hono.fetch(request, env)))
    } catch (e) {
      res = errorResponse(e, request, report)
    } finally {
      // Request-scoped instances end when the handler returns, before a streamed body is read.
      await scope.dispose().catch((e) => report(e, request))
    }
    // An id the app set itself (say, from its own tracing) wins.
    if (!res.headers.has('x-request-id')) res = withHeader(res, 'x-request-id', requestId)
    if (span) {
      span.setAttribute('http.response.status_code', res.status)
      if (matched.route) {
        span.updateName(`${request.method} ${matched.route}`)
        span.setAttribute('http.route', matched.route)
      }
    }
    if (access) {
      const ms = Math.round((performance.now() - started) * 10) / 10
      const at = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info'
      access()[at](`${request.method} ${path} ${res.status} ${ms}ms`, {
        reqId: requestId,
        method: request.method,
        path,
        ...(matched.route ? { route: matched.route } : {}),
        status: res.status,
        ms,
        ...(span?.traceId ? { traceId: span.traceId } : {}),
      })
    }
    return res
  }
  return { fetch, routes }
}

/**
 * Runs middleware and guards in order around `inner`. Every layer turns its own errors into
 * responses, so `await next()` always resolves to a Response, whatever failed further in.
 */
async function runChain(
  uses: readonly Use[],
  ctx: MiddlewareContext,
  scope: RequestScope,
  onError: RequestEnv['report'],
  inner: () => Promise<Response>,
) {
  const step = async (i: number): Promise<Response> => {
    try {
      const u = uses[i]
      if (!u) return await inner()
      const deps = await scope.resolveAll(u.inject)
      if (u.kind === 'guard') {
        if (!(await u.check(ctx, deps))) throw new HttpError(403, `access denied by guard "${u.name}"`)
        return await step(i + 1)
      }
      let called = false
      const next = () => {
        if (called) throw new BolideError(`middleware "${u.name}" called next() twice.`)
        called = true
        return step(i + 1)
      }
      const res = await u.handle(ctx, next, deps)
      if (!(res instanceof Response)) throw new BolideError(`middleware "${u.name}" must return a Response (usually the one from next()).`)
      return res
    } catch (e) {
      return errorResponse(e, ctx.request, onError)
    }
  }
  return step(0)
}

async function input(where: string, schema: StandardSchemaV1 | undefined, value: unknown) {
  if (!schema) return value
  const result = await parse(schema, value)
  if (!result.ok) throw new ValidationError(where, result.issues)
  return result.value
}

async function readJson(request: Request, limit: number) {
  // Requiring a JSON content type makes cross-site form posts need a CORS preflight (CSRF).
  const type = request.headers.get('content-type')?.split(';')[0]!.trim().toLowerCase() ?? ''
  const isJson = type === 'application/json' || type.endsWith('+json')
  const notJson = () => new HttpError(415, 'request body must be JSON (Content-Type: application/json)')
  // A declared non-JSON type fails before reading. A missing one waits for the bytes,
  // because Node adapters attach a stream to every POST, even an empty one.
  if (type && !isJson) throw notJson()
  const text = await readText(request, limit)
  // An empty body has nothing to forge; let the schema decide whether it's allowed.
  if (!text) return undefined
  if (!isJson) throw notJson()
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
}

async function readText(request: Request, limit: number) {
  const tooLarge = () => new HttpError(413, `request body exceeds ${limit} bytes`)
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw tooLarge()
  if (!request.body) return ''
  // Content-Length can be absent (chunked) or wrong, so count the bytes as they arrive.
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) bytes.set(c, (offset += c.byteLength) - c.byteLength)
  return new TextDecoder().decode(bytes)
}

/**
 * Response.redirect() and fetch() results have immutable headers; a copy lets middleware set them.
 * Upgrades (101) and responses whose body was read can't be rebuilt, so they pass through as is.
 */
export function mutable(res: Response): Response {
  return res.status >= 200 && !res.bodyUsed ? new Response(res.body, res) : res
}

function toResponse(result: unknown, status: number): Response {
  if (result instanceof Response) return mutable(result)
  if (result === undefined) return new Response(null, { status: 204 })
  return Response.json(result, { status })
}

function errorResponse(e: unknown, request: Request, onError: RequestEnv['report']): Response {
  if (e instanceof ValidationError) {
    return Response.json({ error: 'validation_failed', message: e.message, where: e.where, issues: e.issues }, { status: 400 })
  }
  if (e instanceof HttpError) {
    const body = { error: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) }
    return Response.json(body, { status: e.status })
  }
  onError(e, request)
  return Response.json({ error: 'internal_error', message: 'internal server error' }, { status: 500 })
}

/** Reuse a caller's id only when it can't inject anything into logs or headers. */
function incomingId(value: string | null) {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined
}

/** Sets a header, copying the response when its headers are immutable. Upgrades (101) pass through untouched. */
function withHeader(res: Response, name: string, value: string) {
  if (res.status < 200) return res
  try {
    res.headers.set(name, value)
    return res
  } catch {
    const copy = mutable(res)
    if (copy !== res) copy.headers.set(name, value)
    return copy
  }
}

function joinPath(prefix: string, path: string) {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

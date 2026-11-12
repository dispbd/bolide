import { Hono } from 'hono'
import type { Container } from './container.ts'
import { BolideError, HttpError, ValidationError } from './errors.ts'
import type { Module } from './module.ts'
import type { AnyRoute, Method } from './route.ts'
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

export type ErrorReporter = (error: unknown, request: Request) => void

/**
 * Turns the modules' routes into a Hono app. Hono stays an implementation
 * detail (ADR 0001): user code only sees Request, Response and our types.
 */
export interface HttpOptions {
  /** Max request body size in bytes for routes with a `body` schema. Larger bodies get 413. */
  bodyLimit: number
}

export function buildHttp(container: Container, modules: readonly Module[], onError: ErrorReporter, options: HttpOptions) {
  const hono = new Hono()
  const routes: RouteInfo[] = []
  const seen = new Map<string, { module: string; path: string }>()

  for (const m of modules) {
    for (const route of m.routes) {
      const path = joinPath(m.prefix, route.path)
      // Param names don't matter to the router: /users/:id and /users/:userId clash.
      const key = `${route.method} ${path.replace(/\/:[^/]+/g, '/:')}`
      const clash = seen.get(key)
      if (clash) {
        const where = clash.module === m.name ? `twice in "${m.name}"` : `in both "${clash.module}" and "${m.name}"`
        throw new BolideError(`route ${route.method} ${path} clashes with ${route.method} ${clash.path}: defined ${where}.`)
      }
      seen.set(key, { module: m.name, path })
      routes.push({ method: route.method, path, module: m.name, route })

      hono.on(route.method, path, async (c) => {
        const request = c.req.raw
        const scope = container.createScope(new Map<AnyService, unknown>([[CurrentRequest, request]]))
        try {
          const ctx = {
            params: await input('params', route.params, c.req.param()),
            query: await input('query', route.query, c.req.query()),
            body: route.body ? await input('body', route.body, await readJson(request, options.bodyLimit)) : undefined,
            request,
          }
          const deps = await scope.resolveAll(route.inject)
          return toResponse(await route.handler(ctx as never, deps))
        } catch (e) {
          return errorResponse(e, request, onError)
        } finally {
          // Request-scoped instances end when the handler returns, before a streamed body is read.
          // Request-scoped instances end when the handler returns, before a streamed body is read.
          await scope.dispose().catch((e) => onError(e, request))
        }
      })
    }
  }

  hono.notFound((c) => Response.json({ error: 'not_found', message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` }, { status: 404 }))
  return { fetch: (req: Request) => hono.fetch(req), routes }
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
  if (type !== 'application/json' && !type.endsWith('+json')) {
    throw new HttpError(415, 'request body must be JSON (Content-Type: application/json)')
  }
  const text = await readText(request, limit)
  if (!text) return undefined
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

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result
  if (result === undefined) return new Response(null, { status: 204 })
  return Response.json(result)
}

function errorResponse(e: unknown, request: Request, onError: ErrorReporter): Response {
  if (e instanceof ValidationError) {
    return Response.json({ error: 'validation_failed', where: e.where, issues: e.issues }, { status: 400 })
  }
  if (e instanceof HttpError) {
    const body = { error: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) }
    return Response.json(body, { status: e.status })
  }
  onError(e, request)
  return Response.json({ error: 'internal_error' }, { status: 500 })
}

function joinPath(prefix: string, path: string) {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

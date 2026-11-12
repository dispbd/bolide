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
export function buildHttp(container: Container, modules: readonly Module[], onError: ErrorReporter) {
  const hono = new Hono()
  const routes: RouteInfo[] = []
  const seen = new Map<string, string>()

  for (const m of modules) {
    for (const route of m.routes) {
      const path = joinPath(m.prefix, route.path)
      const key = `${route.method} ${path}`
      const clash = seen.get(key)
      if (clash) throw new BolideError(`route ${key} is defined in both "${clash}" and "${m.name}".`)
      seen.set(key, m.name)
      routes.push({ method: route.method, path, module: m.name, route })

      hono.on(route.method, path, async (c) => {
        const request = c.req.raw
        const scope = container.createScope(new Map<AnyService, unknown>([[CurrentRequest, request]]))
        try {
          const ctx = {
            params: await input('params', route.params, c.req.param()),
            query: await input('query', route.query, c.req.query()),
            body: route.body ? await input('body', route.body, await readJson(request)) : undefined,
            request,
          }
          const deps = await scope.resolveAll(route.inject)
          return toResponse(await route.handler(ctx as never, deps))
        } catch (e) {
          return errorResponse(e, request, onError)
        } finally {
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

async function readJson(request: Request) {
  const text = await request.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
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
    return Response.json({ error: e.message, ...(e.details === undefined ? {} : { details: e.details }) }, { status: e.status })
  }
  onError(e, request)
  return Response.json({ error: 'internal_error' }, { status: 500 })
}

function joinPath(prefix: string, path: string) {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

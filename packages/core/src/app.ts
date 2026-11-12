import { AppEnv, processEnv, type Env } from './config.ts'
import { Container, type Override } from './container.ts'
import { buildHttp, CurrentRequest, type ErrorReporter, type RouteInfo } from './http.ts'
import { BolideError } from './errors.ts'
import { createLogger, isLogLevel, Log, RequestId, RequestLog, type Logger } from './log.ts'
import type { Use } from './middleware.ts'
import type { Module } from './module.ts'
import { openApiDocument, type OpenApiOptions } from './openapi.ts'
import type { AnyService, InstanceOf } from './service.ts'

export interface AppOptions {
  modules: readonly Module[]
  /** Replace services, typically in tests. */
  overrides?: readonly Override[]
  /** Environment for `AppEnv` and configs. Defaults to `process.env` where it exists. */
  env?: Env
  /** Called for unexpected errors (the client gets a plain 500). Defaults to logging them at `error` level. */
  onError?: ErrorReporter
  /**
   * The app's logger, injectable as `Log` (and `RequestLog` with the request id).
   * Defaults to `LOG_LEVEL` (default `info`) and `LOG_FORMAT` (`json` in production, otherwise `pretty`) from the env.
   */
  logger?: Logger
  /** Log one line per request (method, path, status, duration, request id). Default true. */
  accessLog?: boolean
  /** Max request body size in bytes; larger bodies get 413. Default 1 MiB. */
  bodyLimit?: number
  /** Serve an OpenAPI 3.1 document built from the routes (at `/openapi.json` by default). */
  openapi?: OpenApiOptions
  /** App-wide middleware and guards, outermost first. They run for every request, including 404s. */
  use?: readonly Use[]
}

export interface App {
  /** Standard fetch handler: works with Node (via `@bolide/core/node`), Bun, Deno and edge runtimes. */
  fetch(request: Request): Promise<Response>
  /** A singleton service instance. */
  get<S extends AnyService>(service: S): InstanceOf<S>
  /** Every route with its full path, for docs and tooling. */
  readonly routes: readonly RouteInfo[]
  /** Runs onDestroy hooks. Call it on shutdown. */
  close(): Promise<void>
}

/** Validates the module graph, starts every singleton and returns a ready app. */
export async function createApp(options: AppOptions): Promise<App> {
  const env = options.env ?? processEnv()
  const logger = options.logger ?? defaultLogger(env)
  const container = new Container({
    modules: options.modules,
    builtins: [CurrentRequest, AppEnv, Log, RequestId, RequestLog],
    // Later overrides win, so a user override of AppEnv or Log beats `env` and `logger`.
    overrides: [{ provide: AppEnv, useValue: env }, { provide: Log, useValue: logger }, ...(options.overrides ?? [])],
  })
  // Through the container, so an override of Log in `overrides` is honored too.
  const log = () => container.get(Log)
  const onError: ErrorReporter =
    options.onError ??
    ((e, req, { requestId }) => log().error('unhandled error', { err: e, reqId: requestId, method: req.method, url: req.url }))
  const bodyLimit = options.bodyLimit ?? 1024 * 1024
  if (!(bodyLimit === Infinity || (Number.isInteger(bodyLimit) && bodyLimit >= 0))) {
    throw new BolideError(`bodyLimit must be a non-negative integer (bytes) or Infinity, got ${bodyLimit}.`)
  }
  const use = options.use ?? []
  for (const u of use) container.checkRootDeps(u)
  const openapi = options.openapi
  const http = buildHttp(container, container.modules, onError, {
    bodyLimit,
    use,
    prelude: openapi && ((routes) => serveOpenApi(routes, openapi)),
    accessLog: (options.accessLog ?? true) ? log : undefined,
  })
  await container.start()
  return {
    fetch: (request) => http.fetch(request),
    get: (service) => container.get(service),
    routes: http.routes,
    close: () => container.stop(),
  }
}

function defaultLogger(env: Env) {
  const level = env.LOG_LEVEL || 'info'
  if (!isLogLevel(level)) throw new BolideError(`LOG_LEVEL must be debug, info, warn or error, got "${level}".`)
  const format = env.LOG_FORMAT || (env.NODE_ENV === 'production' ? 'json' : 'pretty')
  if (format !== 'json' && format !== 'pretty') throw new BolideError(`LOG_FORMAT must be json or pretty, got "${format}".`)
  return createLogger({ level, format })
}

/**
 * Answers GET requests for the document before the router runs, so the document path
 * wins over a param route that would also match it (e.g. `GET /:slug`).
 */
function serveOpenApi(routes: readonly RouteInfo[], options: OpenApiOptions) {
  const path = options.path ?? '/openapi.json'
  if (!path.startsWith('/')) throw new BolideError(`openapi.path must start with "/", got "${path}".`)
  const taken = routes.find((r) => r.method === 'GET' && r.path === path)
  if (taken) throw new BolideError(`openapi.path "${path}" is also a route in module "${taken.module}". Pick another path.`)
  // Built once at boot: routes can't change after createApp.
  const body = JSON.stringify(openApiDocument(routes, options))
  return (request: Request) => {
    if (request.method !== 'GET' || new URL(request.url).pathname !== path) return undefined
    return new Response(body, { headers: { 'content-type': 'application/json' } })
  }
}

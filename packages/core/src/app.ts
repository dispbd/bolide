import { AppEnv, processEnv, type Env } from './config.ts'
import { Container, type Override } from './container.ts'
import { buildHttp, CurrentRequest, type ErrorReporter, type RouteInfo } from './http.ts'
import { BolideError } from './errors.ts'
import type { Module } from './module.ts'
import { openApiDocument, type OpenApiOptions } from './openapi.ts'
import type { AnyService, InstanceOf } from './service.ts'

export interface AppOptions {
  modules: readonly Module[]
  /** Replace services, typically in tests. */
  overrides?: readonly Override[]
  /** Environment for `AppEnv` and configs. Defaults to `process.env` where it exists. */
  env?: Env
  /** Called for unexpected errors (the client gets a plain 500). Defaults to console.error. */
  onError?: ErrorReporter
  /** Max request body size in bytes; larger bodies get 413. Default 1 MiB. */
  bodyLimit?: number
  /** Serve an OpenAPI 3.1 document built from the routes (at `/openapi.json` by default). */
  openapi?: OpenApiOptions
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
  const container = new Container({
    modules: options.modules,
    builtins: [CurrentRequest, AppEnv],
    // Later overrides win, so a user override of AppEnv beats `env`.
    overrides: [{ provide: AppEnv, useValue: options.env ?? processEnv() }, ...(options.overrides ?? [])],
  })
  const onError = options.onError ?? ((e, req) => console.error(`[bolide] ${req.method} ${req.url}`, e))
  const bodyLimit = options.bodyLimit ?? 1024 * 1024
  if (!(bodyLimit === Infinity || (Number.isInteger(bodyLimit) && bodyLimit >= 0))) {
    throw new BolideError(`bodyLimit must be a non-negative integer (bytes) or Infinity, got ${bodyLimit}.`)
  }
  const http = buildHttp(container, container.modules, onError, { bodyLimit })
  const docs = options.openapi && serveOpenApi(http.routes, options.openapi)
  await container.start()
  return {
    fetch: async (request) => docs?.(request) ?? http.fetch(request),
    get: (service) => container.get(service),
    routes: http.routes,
    close: () => container.stop(),
  }
}

/** Answers GET requests for the document; everything else falls through to the routes. */
function serveOpenApi(routes: readonly RouteInfo[], options: OpenApiOptions) {
  const path = options.path ?? '/openapi.json'
  const taken = routes.find((r) => r.method === 'GET' && r.path === path)
  if (taken) throw new BolideError(`openapi.path "${path}" is also a route in module "${taken.module}". Pick another path.`)
  // Built once at boot: routes can't change after createApp.
  const body = JSON.stringify(openApiDocument(routes, options))
  return (request: Request) => {
    if (request.method !== 'GET' || new URL(request.url).pathname !== path) return undefined
    return new Response(body, { headers: { 'content-type': 'application/json' } })
  }
}

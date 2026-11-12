import { AppEnv, processEnv, type Env } from './config.ts'
import { Container, type Override } from './container.ts'
import { buildHttp, CurrentRequest, type ErrorReporter, type RouteInfo } from './http.ts'
import type { Module } from './module.ts'
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
  const http = buildHttp(container, container.modules, onError, { bodyLimit: options.bodyLimit ?? 1024 * 1024 })
  await container.start()
  return {
    fetch: async (request) => http.fetch(request),
    get: (service) => container.get(service),
    routes: http.routes,
    close: () => container.stop(),
  }
}

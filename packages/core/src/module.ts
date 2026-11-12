import type { Override } from './container.ts'
import type { Use } from './middleware.ts'
import type { AnyRoute } from './route.ts'
import type { AnyService } from './service.ts'

export interface Module {
  readonly kind: 'module'
  readonly name: string
  readonly imports: readonly Module[]
  /** The services this module provides (bound tokens included). */
  readonly providers: readonly AnyService[]
  /** Tokens this module provides with another implementation, from `bind()`. */
  readonly bindings: ReadonlyMap<AnyService, Override>
  /** Services (or whole imported modules) that importing modules may inject. */
  readonly exports: readonly (AnyService | Module)[]
  /** A global module's exports are visible everywhere without importing it. */
  readonly global: boolean
  readonly routes: readonly AnyRoute[]
  /** Prepended to the paths of this module's own routes. */
  readonly prefix: string
  /** Middleware and guards for this module's own routes, outermost first. */
  readonly use: readonly Use[]
}

export interface ModuleOptions {
  name: string
  imports?: readonly Module[]
  /** Services, or `bind(Token, { useValue | useService })` to provide a token with another implementation. */
  providers?: readonly (AnyService | Override)[]
  exports?: readonly (AnyService | Module)[]
  global?: boolean
  routes?: readonly AnyRoute[]
  prefix?: string
  use?: readonly Use[]
}

/**
 * Groups services. A module sees its own providers, the exports of the
 * modules it imports, and the exports of global modules. Nothing else.
 */
export function defineModule(options: ModuleOptions): Module {
  return {
    kind: 'module',
    name: options.name,
    imports: options.imports ?? [],
    providers: (options.providers ?? []).map((p) => ('provide' in p ? p.provide : p)),
    bindings: new Map((options.providers ?? []).flatMap((p) => ('provide' in p ? [[p.provide, p] as const] : []))),
    exports: options.exports ?? [],
    global: options.global ?? false,
    routes: options.routes ?? [],
    prefix: options.prefix ?? '',
    use: options.use ?? [],
  }
}

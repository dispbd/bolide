import type { AnyService } from './service.ts'

export interface Module {
  readonly kind: 'module'
  readonly name: string
  readonly imports: readonly Module[]
  readonly providers: readonly AnyService[]
  /** Services (or whole imported modules) that importing modules may inject. */
  readonly exports: readonly (AnyService | Module)[]
  /** A global module's exports are visible everywhere without importing it. */
  readonly global: boolean
}

export interface ModuleOptions {
  name: string
  imports?: readonly Module[]
  providers?: readonly AnyService[]
  exports?: readonly (AnyService | Module)[]
  global?: boolean
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
    providers: options.providers ?? [],
    exports: options.exports ?? [],
    global: options.global ?? false,
  }
}

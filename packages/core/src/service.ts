/**
 * `singleton`: one instance for the whole app (default).
 * `request`: one instance per request, disposed when the request ends.
 */
export type Scope = 'singleton' | 'request'

export type AnyService = Service<any, any>
export type Deps = Record<string, AnyService>

/** The instances a set of dependencies resolves to. */
export type Resolved<D extends Deps> = { [K in keyof D]: InstanceOf<D[K]> }
export type InstanceOf<S> = S extends { factory(deps: never): infer R } ? Awaited<R> : never

export interface Service<T, D extends Deps = Deps> {
  readonly kind: 'service'
  readonly name: string
  readonly scope: Scope
  readonly inject: D
  // Method syntax keeps services assignable to AnyService whatever their instance type.
  factory(deps: Resolved<D>): T | Promise<T>
  onInit?(instance: T): void | Promise<void>
  onDestroy?(instance: T): void | Promise<void>
}

export interface ServiceOptions<T, D extends Deps> {
  /** Used in error messages and diagnostics. */
  name: string
  /** Other services this one needs, by reference. Their instances are passed to `factory`. */
  inject?: D
  factory: (deps: Resolved<D>) => T | Promise<T>
  scope?: Scope
  /** Runs after every service this one depends on is ready. */
  onInit?: (instance: T) => void | Promise<void>
  /** Runs on shutdown, in reverse init order. */
  onDestroy?: (instance: T) => void | Promise<void>
}

/**
 * Declares a service. The returned object is also its token: inject it by
 * reference, no strings and no decorators.
 *
 * ```ts
 * const Users = defineService({
 *   name: 'Users',
 *   inject: { db: Db },
 *   factory: ({ db }) => ({ find: (id: string) => db.users.get(id) }),
 * })
 * ```
 */
export function defineService<T, D extends Deps = {}>(options: ServiceOptions<T, D>): Service<T, D> {
  return {
    kind: 'service',
    name: options.name,
    scope: options.scope ?? 'singleton',
    inject: options.inject ?? ({} as D),
    factory: options.factory,
    onInit: options.onInit,
    onDestroy: options.onDestroy,
  }
}

/** A service that is just a value, handy for constants and for tests. */
export function defineValue<T>(name: string, value: T): Service<T, {}> {
  return defineService({ name, factory: () => value })
}

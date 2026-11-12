import { DependencyError } from './errors.ts'
import type { Module } from './module.ts'
import type { AnyService, InstanceOf, Service } from './service.ts'

export type Override = { provide: AnyService; useValue: unknown } | { provide: AnyService; useService: AnyService }

/**
 * Provides `token` with another implementation, inside a module's `providers`. The token stays
 * what others inject; the implementation's dependencies must be visible from that module.
 * Batteries use it to let you pick a driver: `bind(CacheDriver, { useValue: redisStore(client) })`.
 */
export function bind<S extends AnyService>(
  token: S,
  by: { useValue: InstanceOf<S> } | { useService: Service<InstanceOf<S>, any> },
): Override {
  return { provide: token, ...by } as Override
}

/** Type-checked override: the replacement must match the original's instance type. */
export function override<S extends AnyService>(
  provide: S,
  by: { useValue: InstanceOf<S> } | { useService: Service<InstanceOf<S>, any> },
): Override {
  return { provide, ...by } as Override
}

export interface ContainerOptions {
  modules: readonly Module[]
  /** Services every module can see without importing anything (built-ins such as the app env). */
  builtins?: readonly AnyService[]
  /** Replace services, typically in tests. Overrides are not checked for visibility. */
  overrides?: readonly Override[]
}

/**
 * Resolves the module graph once at boot and fails fast on mistakes:
 * missing providers, invisible dependencies, cycles, scope violations.
 */
export class Container {
  readonly modules: readonly Module[]
  /** Which module provides each service. */
  readonly owner = new Map<AnyService, Module>()
  private readonly visible = new Map<Module, Set<AnyService>>()
  private readonly replaced = new Map<AnyService, Override>()
  /** Module-level bindings: token -> implementation. App overrides still win over them. */
  private readonly bound = new Map<AnyService, Override>()
  private readonly builtins: Set<AnyService>
  /** What app-wide middleware sees: built-ins, globals and the exports of the app's modules. */
  private readonly rootVisible: Set<AnyService>
  private readonly singletons = new Map<AnyService, unknown>()
  private readonly initOrder: AnyService[] = []
  private state: 'new' | 'starting' | 'started' | 'stopped' = 'new'

  constructor(options: ContainerOptions) {
    this.builtins = new Set(options.builtins ?? [])
    for (const o of options.overrides ?? []) this.replaced.set(o.provide, o)
    this.modules = collectModules(options.modules)
    for (const m of this.modules) {
      for (const p of m.providers) {
        const other = this.owner.get(p)
        if (other && other !== m) {
          throw new DependencyError(`service "${p.name}" is provided by both "${other.name}" and "${m.name}". Provide it in one module and export it.`)
        }
        this.owner.set(p, m)
        const b = m.bindings.get(p)
        if (b) this.bound.set(p, b)
      }
    }
    const globals = new Set<AnyService>()
    for (const m of this.modules) if (m.global) for (const s of exported(m)) globals.add(s)
    this.rootVisible = new Set([...this.builtins, ...globals])
    for (const m of options.modules) for (const s of exported(m)) this.rootVisible.add(s)
    for (const m of this.modules) {
      const v = new Set<AnyService>([...this.builtins, ...globals, ...m.providers])
      for (const i of m.imports) for (const s of exported(i)) v.add(s)
      this.visible.set(m, v)
    }
    for (const m of this.modules) {
      for (const e of m.exports) {
        if (e.kind === 'service' && !m.providers.includes(e) && !this.visible.get(m)!.has(e)) {
          throw new DependencyError(`module "${m.name}" exports "${e.name}", which it neither provides nor imports.`)
        }
        if (e.kind === 'module' && !m.imports.includes(e)) {
          throw new DependencyError(`module "${m.name}" re-exports module "${e.name}" without importing it.`)
        }
      }
      for (const p of m.providers) this.checkDeps(m, p)
      for (const r of m.routes) {
        this.checkDeps(m, { name: `${r.method} ${m.prefix}${r.path}`, inject: r.inject }, 'route')
        for (const u of r.use) this.checkDeps(m, u, u.kind)
      }
      for (const u of m.use) this.checkDeps(m, u, u.kind)
    }
    this.checkCycles()
  }

  /** Throws unless every dependency of `consumer` is visible from module `m`. */
  checkDeps(m: Module, consumer: { name: string; inject: Record<string, AnyService>; scope?: string }, what = 'service') {
    const effective = this.effective(consumer as AnyService)
    // An app override's deps are not checked for visibility (it may come from anywhere),
    // but a module binding's are, and a singleton reaching a request-scoped service is a mistake either way.
    const overridden = effective !== consumer
    const fromApp = this.replaced.has(consumer as AnyService)
    const scope = overridden ? effective.scope : consumer.scope
    for (const dep of Object.values(overridden ? depsOf(effective) : consumer.inject)) {
      if (!fromApp && !this.visible.get(m)!.has(dep)) {
        const where = this.owner.get(dep)
        const hint = where
          ? `"${where.name}" provides it; import that module and make sure it exports "${dep.name}".`
          : `no module provides it; add it to the providers of "${m.name}" or of a module it imports.`
        const who = overridden ? `"${consumer.name}" (bound to "${effective.name}")` : `"${consumer.name}"`
        throw new DependencyError(`${what} ${who} in module "${m.name}" injects "${dep.name}", which is not visible: ${hint}`)
      }
      if (scope === 'singleton' && this.effective(dep).scope === 'request') {
        const by = overridden ? `"${consumer.name}" (${fromApp ? 'overridden by' : 'bound to'} "${effective.name}")` : `"${consumer.name}"`
        throw new DependencyError(`singleton ${by} cannot inject request-scoped "${dep.name}". Make it request-scoped too.`)
      }
    }
  }

  /** Throws unless app-wide middleware can see each of its dependencies. */
  checkRootDeps(consumer: { name: string; kind: string; inject: Record<string, AnyService> }) {
    for (const dep of Object.values(consumer.inject)) {
      if (this.rootVisible.has(dep)) continue
      const where = this.owner.get(dep)
      const hint = where
        ? `export it from "${where.name}" (and pass that module to createApp), or make "${where.name}" global.`
        : 'no module provides it; add it to a module passed to createApp and export it.'
      throw new DependencyError(`app ${consumer.kind} "${consumer.name}" injects "${dep.name}", which is not visible: ${hint}`)
    }
  }

  get<S extends AnyService>(service: S): InstanceOf<S> {
    if (this.state !== 'started') throw new DependencyError(`cannot get "${service.name}": the container is ${this.state}.`)
    if (!this.singletons.has(service)) {
      const s = this.effective(service)
      if (s.scope === 'request') throw new DependencyError(`"${service.name}" is request-scoped; resolve it inside a request scope.`)
      throw new DependencyError(`"${service.name}" is not provided by any module.`)
    }
    return this.singletons.get(service) as InstanceOf<S>
  }

  /** Creates every singleton in dependency order and runs onInit hooks. */
  async start() {
    if (this.state !== 'new') throw new DependencyError(`container already ${this.state}.`)
    this.state = 'starting'
    const all = [...this.builtins, ...this.owner.keys()]
    try {
      for (const s of all) await this.instantiate(s, [])
    } catch (e) {
      await this.stop().catch(() => {})
      throw e
    }
    this.state = 'started'
  }

  /** Runs onDestroy hooks in reverse init order. Collects every failure. */
  async stop() {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    const errors: unknown[] = []
    for (const s of [...this.initOrder].reverse()) {
      const eff = this.effective(s)
      try {
        await eff.onDestroy?.(this.singletons.get(s))
      } catch (e) {
        errors.push(e)
      }
    }
    this.singletons.clear()
    if (errors.length) throw new AggregateError(errors, 'some services failed to stop')
  }

  /** A per-request resolver. Request-scoped services are created lazily and disposed together. */
  createScope(seed?: ReadonlyMap<AnyService, unknown>): RequestScope {
    return new RequestScope(this, seed)
  }

  /** @internal */
  singleton(s: AnyService) {
    return this.singletons.get(s)
  }

  /** @internal The service definition that actually runs for `s`, after overrides. */
  effective(s: AnyService): AnyService {
    const o = this.replaced.get(s) ?? this.bound.get(s)
    if (!o) return s
    if ('useService' in o) return o.useService
    return { ...s, inject: {}, factory: () => o.useValue, onInit: undefined, onDestroy: undefined }
  }

  private async instantiate(s: AnyService, path: AnyService[]): Promise<unknown> {
    if (this.singletons.has(s)) return this.singletons.get(s)
    const eff = this.effective(s)
    if (eff.scope === 'request') {
      // checkDeps should have caught this at construction; never hand a singleton `undefined`.
      if (path.length) throw new DependencyError(`singleton "${path.at(-1)!.name}" cannot inject request-scoped "${s.name}". Make "${path.at(-1)!.name}" request-scoped too, or inject a singleton.`)
      return undefined
    }
    const deps: Record<string, unknown> = {}
    for (const [key, dep] of Object.entries(depsOf(eff))) deps[key] = await this.instantiate(dep, [...path, s])
    const instance = await eff.factory(deps as never)
    this.singletons.set(s, instance)
    this.initOrder.push(s)
    await eff.onInit?.(instance)
    return instance
  }

  private checkCycles() {
    const done = new Set<AnyService>()
    const visit = (s: AnyService, stack: AnyService[]) => {
      if (done.has(s)) return
      const i = stack.indexOf(s)
      if (i >= 0) {
        const cycle = [...stack.slice(i), s].map((x) => x.name).join(' -> ')
        throw new DependencyError(`dependency cycle: ${cycle}. Break it by moving the shared part into its own service.`)
      }
      for (const dep of Object.values(depsOf(this.effective(s)))) visit(dep, [...stack, s])
      done.add(s)
    }
    for (const s of [...this.builtins, ...this.owner.keys()]) visit(s, [])
  }
}

export class RequestScope {
  private readonly instances: Map<AnyService, unknown>
  private readonly order: AnyService[] = []
  constructor(
    private readonly container: Container,
    seed?: ReadonlyMap<AnyService, unknown>,
  ) {
    // Seeded values (such as the current Request) are provided by the caller, not built.
    this.instances = new Map(seed)
  }

  async resolve<S extends AnyService>(service: S): Promise<InstanceOf<S>> {
    const eff = this.container.effective(service)
    if (eff.scope === 'singleton') return this.container.get(service)
    if (this.instances.has(service)) return this.instances.get(service) as InstanceOf<S>
    const deps: Record<string, unknown> = {}
    for (const [key, dep] of Object.entries(depsOf(eff))) deps[key] = await this.resolve(dep)
    const instance = await eff.factory(deps as never)
    this.instances.set(service, instance)
    this.order.push(service)
    await eff.onInit?.(instance)
    return instance as InstanceOf<S>
  }

  async resolveAll<D extends Record<string, AnyService>>(deps: D) {
    const out: Record<string, unknown> = {}
    for (const [key, dep] of Object.entries(deps)) out[key] = await this.resolve(dep)
    return out as { [K in keyof D]: InstanceOf<D[K]> }
  }

  async dispose() {
    const errors: unknown[] = []
    for (const s of this.order.reverse()) {
      try {
        await this.container.effective(s).onDestroy?.(this.instances.get(s))
      } catch (e) {
        errors.push(e)
      }
    }
    this.instances.clear()
    if (errors.length) throw new AggregateError(errors, 'some request-scoped services failed to dispose')
  }
}

function depsOf(s: AnyService): Record<string, AnyService> {
  return s.inject
}

function exported(m: Module): AnyService[] {
  return m.exports.flatMap((e) => (e.kind === 'service' ? [e] : exported(e)))
}

function collectModules(roots: readonly Module[]): Module[] {
  const out: Module[] = []
  const visit = (m: Module, stack: Module[]) => {
    if (stack.includes(m)) {
      throw new DependencyError(`module import cycle: ${[...stack.slice(stack.indexOf(m)), m].map((x) => x.name).join(' -> ')}`)
    }
    if (out.includes(m)) return
    for (const i of m.imports) visit(i, [...stack, m])
    out.push(m)
  }
  for (const r of roots) visit(r, [])
  return out
}

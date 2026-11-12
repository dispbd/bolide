import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Container, override } from '../src/container.ts'
import { DependencyError } from '../src/errors.ts'
import { defineModule } from '../src/module.ts'
import { defineService, defineValue } from '../src/service.ts'

const Db = defineService({ name: 'Db', factory: () => ({ rows: new Map<string, string>([['1', 'ann']]) }) })
const Users = defineService({
  name: 'Users',
  inject: { db: Db },
  factory: ({ db }) => ({ find: (id: string) => db.rows.get(id) }),
})

const boot = async (...modules: Parameters<typeof defineModule>[0][]) => {
  const c = new Container({ modules: modules.map(defineModule) })
  await c.start()
  return c
}

describe('resolution', () => {
  test('injects dependencies by reference', async () => {
    const c = await boot({ name: 'app', providers: [Db, Users] })
    assert.equal(c.get(Users).find('1'), 'ann')
  })

  test('singletons are created once', async () => {
    let made = 0
    const Counter = defineService({ name: 'Counter', factory: () => ({ n: ++made }) })
    const A = defineService({ name: 'A', inject: { c: Counter }, factory: ({ c }) => c })
    const B = defineService({ name: 'B', inject: { c: Counter }, factory: ({ c }) => c })
    const c = await boot({ name: 'app', providers: [Counter, A, B] })
    assert.equal(made, 1)
    assert.equal(c.get(A), c.get(B))
  })

  test('async factories are awaited', async () => {
    const Slow = defineService({ name: 'Slow', factory: async () => ({ ready: true }) })
    const c = await boot({ name: 'app', providers: [Slow] })
    assert.equal(c.get(Slow).ready, true)
  })

  test('imported modules share their exports', async () => {
    const db = defineModule({ name: 'db', providers: [Db], exports: [Db] })
    const users = defineModule({ name: 'users', imports: [db], providers: [Users] })
    const c = new Container({ modules: [users] })
    await c.start()
    assert.equal(c.get(Users).find('1'), 'ann')
  })

  test('a module can re-export an imported module', async () => {
    const db = defineModule({ name: 'db', providers: [Db], exports: [Db] })
    const infra = defineModule({ name: 'infra', imports: [db], exports: [db] })
    const users = defineModule({ name: 'users', imports: [infra], providers: [Users] })
    await new Container({ modules: [users] }).start()
  })

  test('global modules are visible without importing', async () => {
    const db = defineModule({ name: 'db', providers: [Db], exports: [Db], global: true })
    const users = defineModule({ name: 'users', providers: [Users] })
    await new Container({ modules: [db, users] }).start()
  })
})

describe('boot-time errors', () => {
  const fails = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e) => e instanceof DependencyError && re.test(e.message))

  test('dependency not provided anywhere', () => {
    fails(() => new Container({ modules: [defineModule({ name: 'users', providers: [Users] })] }), /injects "Db", which is not visible: no module provides it/)
  })

  test('dependency provided but not exported', () => {
    const db = defineModule({ name: 'db', providers: [Db] })
    const users = defineModule({ name: 'users', imports: [db], providers: [Users] })
    fails(() => new Container({ modules: [users] }), /"db" provides it; import that module and make sure it exports "Db"/)
  })

  test('dependency exported but not imported', () => {
    const db = defineModule({ name: 'db', providers: [Db], exports: [Db] })
    const users = defineModule({ name: 'users', providers: [Users] })
    fails(() => new Container({ modules: [db, users] }), /not visible: "db" provides it/)
  })

  test('the same service in two modules', () => {
    fails(
      () => new Container({ modules: [defineModule({ name: 'a', providers: [Db] }), defineModule({ name: 'b', providers: [Db] })] }),
      /provided by both "a" and "b"/,
    )
  })

  test('exporting something the module does not have', () => {
    fails(() => new Container({ modules: [defineModule({ name: 'a', exports: [Db] })] }), /exports "Db", which it neither provides nor imports/)
  })

  test('dependency cycle names the whole path', () => {
    const A: any = defineService({ name: 'A', inject: {}, factory: () => 1 })
    const B = defineService({ name: 'B', inject: { a: A }, factory: () => 2 })
    A.inject.b = B
    fails(() => new Container({ modules: [defineModule({ name: 'app', providers: [A, B] })] }), /dependency cycle: A -> B -> A/)
  })

  test('module import cycle', () => {
    const a: any = defineModule({ name: 'a' })
    const b = defineModule({ name: 'b', imports: [a] })
    a.imports.push(b)
    fails(() => new Container({ modules: [a] }), /module import cycle: a -> b -> a/)
  })

  test('singleton cannot inject a request-scoped service', () => {
    const Req = defineService({ name: 'Req', scope: 'request', factory: () => ({}) })
    const S = defineService({ name: 'S', inject: { r: Req }, factory: () => ({}) })
    fails(() => new Container({ modules: [defineModule({ name: 'app', providers: [Req, S] })] }), /singleton "S" cannot inject request-scoped "Req"/)
  })
})

describe('lifecycle', () => {
  test('onInit runs in dependency order, onDestroy in reverse', async () => {
    const log: string[] = []
    const hooks = (name: string) => ({ onInit: () => void log.push(`init ${name}`), onDestroy: () => void log.push(`destroy ${name}`) })
    const A = defineService({ name: 'A', factory: () => 'a', ...hooks('A') })
    const B = defineService({ name: 'B', inject: { a: A }, factory: () => 'b', ...hooks('B') })
    const C = defineService({ name: 'C', inject: { b: B }, factory: () => 'c', ...hooks('C') })
    const c = await boot({ name: 'app', providers: [C, B, A] })
    await c.stop()
    assert.deepEqual(log, ['init A', 'init B', 'init C', 'destroy C', 'destroy B', 'destroy A'])
  })

  test('a failed start stops what was already started', async () => {
    const log: string[] = []
    const A = defineService({ name: 'A', factory: () => 'a', onDestroy: () => void log.push('destroy A') })
    const B = defineService({ name: 'B', inject: { a: A }, factory: () => { throw new Error('boom') } })
    const c = new Container({ modules: [defineModule({ name: 'app', providers: [A, B] })] })
    await assert.rejects(c.start(), /boom/)
    assert.deepEqual(log, ['destroy A'])
  })

  test('stop collects every failure', async () => {
    const bad = (name: string) => defineService({ name, factory: () => 1, onDestroy: () => { throw new Error(name) } })
    const c = await boot({ name: 'app', providers: [bad('X'), bad('Y')] })
    await assert.rejects(c.stop(), (e) => e instanceof AggregateError && e.errors.length === 2)
  })
})

describe('request scope', () => {
  test('one instance per scope, disposed with it', async () => {
    let made = 0
    const disposed: number[] = []
    const Ctx = defineService({
      name: 'Ctx',
      scope: 'request',
      inject: { db: Db },
      factory: ({ db }) => ({ id: ++made, db }),
      onDestroy: (ctx) => void disposed.push(ctx.id),
    })
    const c = await boot({ name: 'app', providers: [Db, Ctx] })
    const s1 = c.createScope()
    const s2 = c.createScope()
    assert.equal(await s1.resolve(Ctx), await s1.resolve(Ctx))
    assert.notEqual((await s1.resolve(Ctx)).id, (await s2.resolve(Ctx)).id)
    assert.equal((await s1.resolve(Ctx)).db, c.get(Db), 'request services get the app singletons')
    await s1.dispose()
    assert.deepEqual(disposed, [1])
  })

  test('get() refuses request-scoped services', async () => {
    const Ctx = defineService({ name: 'Ctx', scope: 'request', factory: () => ({}) })
    const c = await boot({ name: 'app', providers: [Ctx] })
    assert.throws(() => c.get(Ctx), /request-scoped/)
  })
})

describe('overrides', () => {
  test('useValue replaces a service and skips its dependencies', async () => {
    const c = new Container({
      modules: [defineModule({ name: 'app', providers: [Db, Users] })],
      overrides: [override(Users, { useValue: { find: () => 'fake' } })],
    })
    await c.start()
    assert.equal(c.get(Users).find('1'), 'fake')
  })

  test('useService swaps in another implementation', async () => {
    const MemDb = defineValue('MemDb', { rows: new Map([['1', 'bob']]) })
    const c = new Container({ modules: [defineModule({ name: 'app', providers: [Db, Users] })], overrides: [override(Db, { useService: MemDb })] })
    await c.start()
    assert.equal(c.get(Users).find('1'), 'bob')
  })

  test('a singleton override cannot inject a request-scoped service', () => {
    const Ctx = defineService({ name: 'Ctx', scope: 'request', factory: () => ({ id: 1 }) })
    const CtxDb = defineService({ name: 'CtxDb', inject: { ctx: Ctx }, factory: ({ ctx }) => ({ rows: new Map([['1', String(ctx.id)]]) }) })
    assert.throws(
      () => new Container({ modules: [defineModule({ name: 'app', providers: [Ctx, Db, Users] })], overrides: [override(Db, { useService: CtxDb })] }),
      (e: unknown) => e instanceof DependencyError && /singleton "Db" \(overridden by "CtxDb"\) cannot inject request-scoped "Ctx"/.test(e.message),
    )
  })

  test('overriding a dependency with a request-scoped service fails at boot', () => {
    const ReqDb = defineService({ name: 'ReqDb', scope: 'request', factory: () => ({ rows: new Map<string, string>() }) })
    assert.throws(
      () => new Container({ modules: [defineModule({ name: 'app', providers: [Db, Users] })], overrides: [override(Db, { useService: ReqDb })] }),
      /singleton "Users" cannot inject request-scoped "Db"/,
    )
  })
})

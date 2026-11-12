import { window } from './dom.ts'
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, createSSRApp, defineComponent, effectScope, h, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { z } from 'zod'
import { defineMutator, defineShape, defineTable, t } from '@bolide/data'
import { createClient, type SyncSink } from '@bolide/client'
import { bolide, useMutation, useRow, useShape } from '../src/index.ts'


const todos = defineTable('todos', { id: t.uuid().primaryKey(), title: t.text() })
const all = defineShape('todos.all', todos)
const add = defineMutator({
  name: 'todos.add',
  input: z.object({ id: z.uuid(), title: z.string() }),
  run: async ({ tx, input }) => void (await tx.insert(todos, input)),
})
const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function setup(answer: () => Response | Promise<Response> = () => Response.json({ txid: '1' })) {
  const sinks = new Map<string, SyncSink>()
  const client = createClient({
    transport: { subscribe: ({ shape }, sink) => (sinks.set(shape.name, sink), () => void sinks.delete(shape.name)) },
    mutators: [add],
    confirmTimeout: 20,
    fetch: async () => answer(),
  })
  return { client, sinks }
}

describe('vue composables', () => {
  after(() => window.close())

  test('useShape streams while mounted and updates the component', async () => {
    const { client, sinks } = setup()
    const List = defineComponent(() => {
      const { rows, status } = useShape(all)
      return () => h('p', `${status.value}: ${rows.value.map((r) => r.title).join(',')}`)
    })
    const el = document.createElement('div')
    const app = createApp(List).use(bolide(client))
    app.mount(el as unknown as Element)
    assert.equal(el.textContent, 'loading: ')
    sinks.get('todos.all')!.changes([{ type: 'insert', row: { id: crypto.randomUUID(), title: 'a' } }], [])
    sinks.get('todos.all')!.upToDate()
    await wait()
    await nextTick()
    assert.equal(el.textContent, 'ready: a')
    app.unmount()
    await wait(5)
    assert.equal(sinks.size, 0, 'the stream stopped with the component')
  })

  test('useMutation is pending, then rejected with the error, and the row is rolled back', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { client } = setup(async () => (await gate, Response.json({ error: 'forbidden', message: 'no' }, { status: 403 })))
    const id = crypto.randomUUID()
    let call!: () => void
    const App = defineComponent(() => {
      const row = useRow(all, id)
      const m = useMutation(add)
      call = () => void m.mutate({ id, title: 'x' })
      return () => h('p', `${row.value?.title ?? '-'} ${m.status.value} ${m.error.value?.code ?? ''}`)
    })
    const el = document.createElement('div')
    const app = createApp(App).use(bolide(client))
    app.mount(el as unknown as Element)
    call()
    await wait()
    await nextTick()
    assert.equal(el.textContent, 'x pending ', 'optimistic')
    release()
    await wait(5)
    await nextTick()
    assert.equal(el.textContent, '- rejected forbidden')
    app.unmount()
  })

  test('works in an effect scope outside components, and renders on the server as loading', async () => {
    const { client, sinks } = setup()
    const app = createApp({}).use(bolide(client))
    const scope = effectScope()
    const shape = app.runWithContext(() => scope.run(() => useShape(all))!)
    assert.ok(sinks.has('todos.all'), 'subscribed at once')
    scope.stop()
    await wait(5)
    assert.equal(sinks.size, 0)

    const ssr = createSSRApp(defineComponent(() => {
      const { status } = useShape(all)
      return () => h('p', status.value)
    })).use(bolide(client))
    assert.equal(await renderToString(ssr), '<p>loading</p>')
    assert.equal(sinks.size, 0, 'no stream on the server')
    assert.throws(() => effectScope().run(() => useShape(all)), /app.use\(bolide/)
    void shape
  })
})

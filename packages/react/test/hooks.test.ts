import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { z } from 'zod'
import { defineMutator, defineShape, defineTable, t } from '@bolide/data'
import { createClient, type SyncSink, type SyncTransport } from '@bolide/client'
import { BolideProvider, useMutation, useRow, useShape } from '../src/index.ts'

const window = new Window()
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })

const todos = defineTable('todos', { id: t.uuid().primaryKey(), title: t.text() })
const all = defineShape('todos.all', todos)
const add = defineMutator({
  name: 'todos.add',
  input: z.object({ id: z.uuid(), title: z.string() }),
  run: async ({ tx, input }) => void (await tx.insert(todos, input)),
})

function setup(answer: () => Response = () => Response.json({ txid: '1' })) {
  const sinks = new Map<string, SyncSink>()
  let subscribed = 0
  const transport: SyncTransport = {
    subscribe: ({ shape }, sink) => {
      subscribed++
      sinks.set(shape.name, sink)
      return () => sinks.delete(shape.name)
    },
  }
  const client = createClient({ transport, mutators: [add], confirmTimeout: 20, fetch: async () => answer() })
  const container = document.createElement('div')
  const root = createRoot(container as unknown as Element)
  const render = (node: ReactNode) => act(() => root.render(createElement(StrictMode, null, createElement(BolideProvider, { client }, node))))
  return { client, sinks, container, render, root, subscribed: () => subscribed }
}

describe('react hooks', () => {
  after(() => window.close())

  test('useShape shows synced rows and its status, and keeps one stream under StrictMode', async () => {
    const { sinks, container, render, root, subscribed } = setup()
    const List = () => {
      const { rows, status } = useShape(all)
      return createElement('p', null, `${status}: ${rows.map((r) => r.title).join(',')}`)
    }
    await render(createElement(List))
    assert.equal(container.textContent, 'loading: ')
    await act(async () => {
      sinks.get('todos.all')!.changes([{ type: 'insert', row: { id: crypto.randomUUID(), title: 'a' } }], [])
      sinks.get('todos.all')!.upToDate()
    })
    assert.equal(container.textContent, 'ready: a')
    assert.equal(subscribed(), 1, 'the StrictMode remount reused the stream')
    await act(async () => root.unmount())
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(sinks.size, 0, 'stopped after the last component left')
  })

  test('useMutation reports a rejection, and the row is rolled back', async () => {
    const { container, render } = setup(() => Response.json({ error: 'forbidden', message: 'no' }, { status: 403 }))
    const id = crypto.randomUUID()
    let call!: () => void
    const App = () => {
      const row = useRow(all, id)
      const m = useMutation(add)
      call = () => void m.mutate({ id, title: 'x' }).done.catch(() => {})
      return createElement('p', null, `${row?.title ?? '-'} ${m.status} ${m.error?.code ?? ''}`)
    }
    await render(createElement(App))
    assert.equal(container.textContent, '- idle ')
    await act(async () => {
      call()
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(() => new Promise((r) => setTimeout(r, 10)))
    assert.equal(container.textContent, '- rejected forbidden', 'rolled back')
  })

  test('useMutation is pending while the server has not answered, then confirmed', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const sinks = new Map<string, SyncSink>()
    const client = createClient({
      transport: { subscribe: ({ shape }, sink) => (sinks.set(shape.name, sink), () => {}) },
      mutators: [add],
      confirmTimeout: 20,
      fetch: async () => (await gate, Response.json({ txid: '7' })),
    })
    const container = document.createElement('div')
    const root = createRoot(container as unknown as Element)
    const id = crypto.randomUUID()
    let call!: () => void
    const App = () => {
      const { rows } = useShape(all)
      const m = useMutation(add)
      call = () => void m.mutate({ id, title: 'x' })
      return createElement('p', null, `${rows.length} ${m.status}`)
    }
    await act(() => root.render(createElement(BolideProvider, { client }, createElement(App))))
    await act(async () => {
      call()
      await new Promise((r) => setTimeout(r, 0))
    })
    assert.equal(container.textContent, '1 pending', 'optimistic row, not yet confirmed')
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 0))
      sinks.get('todos.all')!.changes([{ type: 'insert', row: { id, title: 'x' } }], ['7'])
      await new Promise((r) => setTimeout(r, 5))
    })
    assert.equal(container.textContent, '1 confirmed')
    await act(async () => root.unmount())
    client.close()
  })

  test('renders on the server with empty rows, and explains a missing provider', () => {
    const client = createClient({ transport: { subscribe: () => () => {} }, mutators: [] })
    const List = () => createElement('p', null, useShape(all).status)
    assert.equal(renderToString(createElement(BolideProvider, { client }, createElement(List))), '<p>loading</p>')
    assert.throws(() => renderToString(createElement(List)), /Wrap the app in <BolideProvider/)
  })
})

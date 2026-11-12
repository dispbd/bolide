import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Client, Mutation, MutationRejected, ShapeStatus } from '@bolide/client'
import type { AnyMutator, AnyShape, MutatorInput, ShapeRow } from '@bolide/data'

const ClientContext = createContext<Client | null>(null)

/** Makes `client` available to the hooks below. */
export function BolideProvider({ client, children }: { client: Client; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: client }, children)
}

/** The client from the nearest `<BolideProvider>`. */
export function useClient(): Client {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useClient: no client. Wrap the app in <BolideProvider client={createClient(...)}>.')
  return client
}

export interface ShapeState<R> {
  /** Synced rows with pending changes applied. The same array until something changes. */
  rows: readonly R[]
  status: ShapeStatus
}

/** The live rows of a shape. Streams while any component uses it; re-renders only when its rows or status change. */
export function useShape<S extends AnyShape>(shape: S): ShapeState<ShapeRow<S>> {
  const client = useClient()
  const view = useMemo(() => client.shape(shape), [client, shape])
  const subscribe = useCallback((onChange: () => void) => view.subscribe(onChange), [view])
  // On the server there is no stream: render the empty loading state, the browser fills it in.
  const rows = useSyncExternalStore(subscribe, view.rows, view.rows)
  const status = useSyncExternalStore(
    subscribe,
    () => view.status,
    () => view.status,
  )
  return { rows, status }
}

/** One row of a shape by its primary key, or undefined while it isn't there (yet). */
export function useRow<S extends AnyShape>(shape: S, key: string | number | undefined): ShapeRow<S> | undefined {
  const { rows } = useShape(shape)
  const pk = shape.table.primaryKey as string
  return useMemo(() => (key === undefined ? undefined : rows.find((r) => (r as Record<string, unknown>)[pk] === key)), [rows, pk, key])
}

/** `pending` from the call until the server confirms (`confirmed`) or refuses it (`rejected`, with `error`). */
export type MutationState = { status: 'idle' | 'pending' | 'confirmed'; error?: undefined } | { status: 'rejected'; error: MutationRejected }

/** `status` and `error` are the state of the latest call from this component. */
export type UseMutation<M extends AnyMutator> = MutationState & {
  /** Applies the change locally at once and sends it. The returned mutation's `done` settles as the server answers. */
  mutate(input: MutatorInput<M>): Mutation
  /** Back to `idle`, e.g. after showing an error. */
  reset(): void
}

/**
 * Calls a mutator and tracks its latest call. The UI doesn't need to wait for `status`: the change is already
 * in every `useShape` that shows it, and is rolled back there if the server refuses it.
 */
export function useMutation<M extends AnyMutator>(mutator: M): UseMutation<M> {
  const client = useClient()
  const [state, setState] = useState<MutationState>({ status: 'idle' })
  const latest = useRef(0)
  const mutate = useCallback(
    (input: MutatorInput<M>) => {
      const m = client.mutate(mutator, input)
      const n = ++latest.current
      setState({ status: 'pending' })
      m.done.then(
        () => latest.current === n && setState({ status: 'confirmed' }),
        (error: MutationRejected) => latest.current === n && setState({ status: 'rejected', error }),
      )
      return m
    },
    [client, mutator],
  )
  const reset = useCallback(() => {
    latest.current++
    setState({ status: 'idle' })
  }, [])
  return { ...state, mutate, reset }
}

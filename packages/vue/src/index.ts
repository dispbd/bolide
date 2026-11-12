import { computed, getCurrentInstance, hasInjectionContext, inject, onMounted, onScopeDispose, onUnmounted, provide, ref, shallowRef, toValue, type InjectionKey, type MaybeRefOrGetter, type Plugin, type Ref } from 'vue'
import type { Client, Mutation, MutationRejected, ShapeStatus } from '@bolide/client'
import type { AnyMutator, AnyShape, MutatorInput, ShapeRow } from '@bolide/data'

const key: InjectionKey<Client> = Symbol('bolide client')

/** Makes `client` available to the composables in the whole app: `createApp(App).use(bolide(client))`. */
export function bolide(client: Client): Plugin {
  return { install: (app) => void app.provide(key, client) }
}

/** Makes `client` available to this component's children only (call it in `setup`). */
export function provideClient(client: Client) {
  provide(key, client)
}

/** The client from `bolide(client)` or `provideClient(client)`. */
export function useClient(): Client {
  const client = hasInjectionContext() ? inject(key, null) : null
  if (!client) throw new Error('useClient: no client. Install it with app.use(bolide(createClient(...))), and call composables in setup (or in app.runWithContext).')
  return client
}

export interface ShapeState<R> {
  /** Synced rows with pending changes applied. A new array (not a deep reactive copy) when something changes. */
  rows: Readonly<Ref<readonly R[]>>
  status: Readonly<Ref<ShapeStatus>>
}

/**
 * The live rows of a shape. A component streams the shape while it is mounted (so server rendering shows the empty
 * `loading` state); outside a component, while the current effect scope lives.
 */
export function useShape<S extends AnyShape>(shape: S): ShapeState<ShapeRow<S>> {
  const view = useClient().shape(shape)
  // shallowRef: rows are replaced, never mutated, so Vue needn't make every row deeply reactive.
  const rows = shallowRef(view.rows())
  const status = ref(view.status)
  let off: (() => void) | undefined
  const start = () => {
    off = view.subscribe(() => {
      rows.value = view.rows()
      status.value = view.status
    })
    rows.value = view.rows()
    status.value = view.status
  }
  const stop = () => {
    off?.()
    off = undefined
  }
  if (getCurrentInstance()) {
    onMounted(start)
    onUnmounted(stop)
  } else {
    start()
    onScopeDispose(stop)
  }
  return { rows, status }
}

/** One row of a shape by its primary key (a value, ref or getter), or undefined while it isn't there. */
export function useRow<S extends AnyShape>(shape: S, id: MaybeRefOrGetter<string | number | undefined>): Readonly<Ref<ShapeRow<S> | undefined>> {
  const { rows } = useShape(shape)
  const pk = shape.table.primaryKey as string
  return computed(() => {
    const want = toValue(id)
    return want === undefined ? undefined : rows.value.find((r) => (r as Record<string, unknown>)[pk] === want)
  })
}

export interface UseMutation<M extends AnyMutator> {
  /** Applies the change locally at once and sends it. The returned mutation's `done` settles as the server answers. */
  mutate(input: MutatorInput<M>): Mutation
  /** The latest call's state: `pending` until the server confirms (`confirmed`) or refuses it (`rejected`). */
  status: Readonly<Ref<'idle' | 'pending' | 'confirmed' | 'rejected'>>
  /** Why the latest call was refused. Its change is already rolled back. */
  error: Readonly<Ref<MutationRejected | undefined>>
  /** Back to `idle`, e.g. after showing an error. */
  reset(): void
}

/** Calls a mutator and tracks its latest call. The rows in every `useShape` already show the change. */
export function useMutation<M extends AnyMutator>(mutator: M): UseMutation<M> {
  const client = useClient()
  const status = ref<'idle' | 'pending' | 'confirmed' | 'rejected'>('idle')
  const error = shallowRef<MutationRejected>()
  let latest = 0
  return {
    status,
    error,
    mutate(input) {
      const m = client.mutate(mutator, input)
      const n = ++latest
      status.value = 'pending'
      error.value = undefined
      m.done.then(
        () => void (latest === n && (status.value = 'confirmed')),
        (e: MutationRejected) => {
          if (latest !== n) return
          status.value = 'rejected'
          error.value = e
        },
      )
      return m
    },
    reset() {
      latest++
      status.value = 'idle'
      error.value = undefined
    },
  }
}

# @bolide/react

React hooks for [`@bolide/client`](../client/README.md): live rows from shapes and optimistic mutations, typed from the same definitions the server uses.

```tsx
import { createClient } from '@bolide/client'
import { electricTransport } from '@bolide/client/electric'
import { BolideProvider, useMutation, useShape } from '@bolide/react'
import { create, toggle, myTodos } from './shared/schema'

const client = createClient({ transport: electricTransport(), mutators: [create, toggle] })

root.render(<BolideProvider client={client}><Todos /></BolideProvider>)

function Todos() {
  const { rows, status } = useShape(myTodos)   // typed rows, live
  const { mutate } = useMutation(toggle)
  if (status === 'loading') return <p>Loading…</p>
  return rows.map((t) => <label key={t.id}><input type="checkbox" checked={t.done} onChange={() => mutate({ id: t.id })} />{t.title}</label>)
}
```

- `useShape(shape)` returns `{ rows, status }`. It is built on `useSyncExternalStore`, so a component re-renders only when its shape's rows or status change. The stream starts with the first component that uses the shape and stops when the last one is gone. On the server it renders the empty `loading` state.
- `useRow(shape, id)` is one row by primary key, or `undefined`.
- `useMutation(mutator)` returns `{ mutate, status, error, reset }`. `mutate(input)` changes the local rows at once and returns the client's `Mutation`. `status` is the latest call's: `idle`, `pending`, then `confirmed`, or `rejected` with a `MutationRejected` in `error`. A rejected change is already rolled back in every shape; `error` is there to tell the user why.
- `useClient()` is the client from `<BolideProvider>`, for anything else (`client.pending()`, for instance).

The UI doesn't have to wait on `status`: show the rows and let them change. Use `status` and `error` for a spinner or a message.

React 18 and 19 are supported (a peer dependency).

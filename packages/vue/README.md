# @bolide/vue

Vue 3 composables for [`@bolide/client`](../client/README.md): live rows from shapes and optimistic mutations, typed from the same definitions the server uses. Same API as [`@bolide/react`](../react/README.md), with refs.

```ts
// main.ts
import { createClient } from '@bolide/client'
import { electricTransport } from '@bolide/client/electric'
import { bolide } from '@bolide/vue'
import { createApp } from 'vue'
import { create, toggle } from './shared/schema'
import App from './App.vue'

createApp(App).use(bolide(createClient({ transport: electricTransport(), mutators: [create, toggle] }))).mount('#app')
```

```vue
<script setup lang="ts">
import { useMutation, useShape } from '@bolide/vue'
import { myTodos, toggle } from './shared/schema'

const { rows, status } = useShape(myTodos)
const { mutate } = useMutation(toggle)
</script>

<template>
  <p v-if="status === 'loading'">Loading…</p>
  <label v-for="t in rows" v-else :key="t.id">
    <input type="checkbox" :checked="t.done" @change="mutate({ id: t.id })" />{{ t.title }}
  </label>
</template>
```

- `useShape(shape)` returns `{ rows, status }` as read-only refs. `rows` is a `shallowRef` that gets a new array when something changes, so rows aren't made deeply reactive. A component streams the shape while it is mounted; server rendering shows the empty `loading` state. Outside components (in `app.runWithContext` with an effect scope), it streams until the scope stops.
- `useRow(shape, id)` is a computed row by primary key; `id` can be a value, a ref or a getter.
- `useMutation(mutator)` returns `{ mutate, status, error, reset }`. `mutate(input)` changes the local rows at once; `status` goes `pending`, then `confirmed` or `rejected` with a `MutationRejected` in `error`. A rejected change is already rolled back.
- `bolide(client)` installs the client app-wide; `provideClient(client)` provides it to one component's children. `useClient()` returns it.

Vue 3.3 or later (a peer dependency).

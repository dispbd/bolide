import type { ShapeRow } from '@bolide/data'
import { useMutation, useShape } from '@bolide/react'
import { useMemo, useState, type FormEvent } from 'react'
import { addTodo, myTodos, removeTodo, renameTodo, toggleTodo } from '../shared/schema.ts'

export function App() {
  const { rows, status } = useShape(myTodos)
  const add = useMutation(addTodo)
  const [title, setTitle] = useState('')
  const sorted = useMemo(() => [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [rows])
  const left = rows.filter((t) => !t.done).length

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Shows in the list now; the input is cleared without waiting for the server.
    add.mutate({ id: crypto.randomUUID(), title })
    setTitle('')
  }

  return (
    <main>
      <h1>Todos</h1>
      <form onSubmit={submit}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="New todo" autoFocus />
        <button disabled={!title.trim()}>Add</button>
      </form>
      {add.status === 'rejected' && <p className="error">Not saved: {add.error.message}</p>}
      {status === 'loading' ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <ul>
            {sorted.map((todo) => (
              <Item key={todo.id} todo={todo} />
            ))}
          </ul>
          <p className="muted">{rows.length ? `${left} of ${rows.length} left` : 'Nothing to do. Open this page in a second tab: changes show in both.'}</p>
        </>
      )}
      {status === 'error' && <p className="error">Lost the connection; retrying…</p>}
    </main>
  )
}

function Item({ todo }: { todo: ShapeRow<typeof myTodos> }) {
  const toggle = useMutation(toggleTodo)
  const rename = useMutation(renameTodo)
  const remove = useMutation(removeTodo)
  const [editing, setEditing] = useState(false)

  return (
    <li className={todo.done ? 'done' : undefined}>
      <input type="checkbox" checked={todo.done} onChange={() => toggle.mutate({ id: todo.id })} aria-label="Done" />
      {editing ? (
        <input
          defaultValue={todo.title}
          autoFocus
          aria-label="Title"
          onBlur={(e) => {
            setEditing(false)
            if (e.target.value.trim() && e.target.value !== todo.title) rename.mutate({ id: todo.id, title: e.target.value })
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      ) : (
        <span onDoubleClick={() => setEditing(true)}>{todo.title}</span>
      )}
      {rename.status === 'rejected' && <small className="error">{rename.error.message}</small>}
      <button onClick={() => remove.mutate({ id: todo.id })} aria-label={`Delete ${todo.title}`}>
        ✕
      </button>
    </li>
  )
}

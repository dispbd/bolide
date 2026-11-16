import type { ShapeRow } from '@bolide/data'
import { useClientStatus, useMutation, useShape } from '@bolide/react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { addTodo, createList, joinList, leaveList, myLists, myTodos, removeTodo, renameTodo, toggleTodo } from '../shared/schema.ts'

const byCreation = <T extends { createdAt: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

export function App() {
  const lists = useShape(myLists)
  const todos = useShape(myTodos)
  const sync = useClientStatus()
  const create = useMutation(createList)
  const join = useMutation(joinList)
  const [selected, setSelected] = useState<string>()
  const sorted = useMemo(() => byCreation(lists.rows), [lists.rows])
  const current = sorted.find((l) => l.id === selected) ?? sorted[0]

  // A share link (?join=<list id>) adds this browser's user to the list; the list arrives once the server agrees.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || lists.status !== 'ready') return
    started.current = true
    const listId = new URLSearchParams(location.search).get('join')
    if (listId) {
      history.replaceState(null, '', location.pathname)
      join.mutate({ listId })
      setSelected(listId)
    } else if (!lists.rows.length) create.mutate({ id: crypto.randomUUID(), name: 'My todos' })
  }, [lists.status, lists.rows.length, join, create])

  return (
    <main>
      <h1>Todos</h1>
      {lists.status === 'loading' ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <nav className="lists">
            {sorted.map((l) => (
              <button key={l.id} className={l.id === current?.id ? 'current' : undefined} onClick={() => setSelected(l.id)}>
                {l.name}
              </button>
            ))}
            <NewList onCreate={(id) => setSelected(id)} />
          </nav>
          {join.status === 'rejected' && <p className="error">Couldn't join: {join.error.message}</p>}
          {current && <List list={current} todos={todos.rows.filter((t) => t.listId === current.id)} />}
        </>
      )}
      {(lists.status === 'error' || todos.status === 'error') && <p className="error">Lost the connection; retrying…</p>}
      {!sync.online && <p className="muted">Offline{sync.pending ? `: ${sync.pending} change${sync.pending > 1 ? 's' : ''} will be sent when the server is back` : ''}.</p>}
    </main>
  )
}

function NewList({ onCreate }: { onCreate: (id: string) => void }) {
  const create = useMutation(createList)
  const [name, setName] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const id = crypto.randomUUID()
    create.mutate({ id, name })
    setName('')
    onCreate(id)
  }
  return (
    <form onSubmit={submit} className="new-list">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New list" aria-label="New list" />
    </form>
  )
}

function List({ list, todos }: { list: ShapeRow<typeof myLists>; todos: ShapeRow<typeof myTodos>[] }) {
  const add = useMutation(addTodo)
  const leave = useMutation(leaveList)
  const [title, setTitle] = useState('')
  const [copied, setCopied] = useState(false)
  const sorted = useMemo(() => byCreation(todos), [todos])
  const left = todos.filter((t) => !t.done).length

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // Shows in the list now; the input is cleared without waiting for the server.
    add.mutate({ id: crypto.randomUUID(), listId: list.id, title })
    setTitle('')
  }
  const share = async () => {
    await navigator.clipboard?.writeText(`${location.origin}/?join=${list.id}`)
    setCopied(true)
  }

  return (
    <section>
      <div className="row">
        <h2>{list.name}</h2>
        <span>
          <button onClick={share}>{copied ? 'Link copied' : 'Share'}</button> <button onClick={() => leave.mutate({ listId: list.id })}>Leave</button>
        </span>
      </div>
      <form onSubmit={submit}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="New todo" autoFocus />
        <button disabled={!title.trim()}>Add</button>
      </form>
      {add.status === 'rejected' && <p className="error">Not saved: {add.error.message}</p>}
      <ul>
        {sorted.map((todo) => (
          <Item key={todo.id} todo={todo} />
        ))}
      </ul>
      <p className="muted">{todos.length ? `${left} of ${todos.length} left` : 'Nothing to do. Share the list: whoever opens the link sees it and its changes live.'}</p>
    </section>
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

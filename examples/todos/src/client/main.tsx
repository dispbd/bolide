import { createClient } from '@bolide/client'
import { electricTransport } from '@bolide/client/electric'
import { indexedDbStorage } from '@bolide/client/idb'
import { BolideProvider } from '@bolide/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { mutators } from '../shared/schema.ts'
import { App } from './App.tsx'

// The server put this browser's anonymous user id in the page; the client uses it only for optimistic runs.
const userId = document.querySelector<HTMLMetaElement>('meta[name="user-id"]')?.content

const client = createClient({
  transport: electricTransport(),
  mutators,
  userId: () => userId,
  // A reload shows the last rows at once, and changes made offline are sent when the server is back.
  storage: indexedDbStorage(),
  onRejected: (m, e) => console.warn(`${m.name} was refused: ${e.message}`),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BolideProvider client={client}>
      <App />
    </BolideProvider>
  </StrictMode>,
)

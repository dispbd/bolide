import { createCollection, createTransaction, type Collection, type Transaction } from '@tanstack/db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import { validate, type MutatorRegistry, type Row } from './mutator.ts'
import { createRecordingTx, type Op } from './recording-tx.ts'

export interface ClientOptions<M extends MutatorRegistry> {
  baseUrl: string
  /** Spike auth: sent as a header. Phase 2 replaces this with real sessions. */
  userId: string
  tables: string[]
  mutators: M
}

export class MutationRejected extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

type Input<M extends MutatorRegistry, K extends keyof M> = Parameters<M[K]['run']>[0]['input']

export function createBolideClient<M extends MutatorRegistry>(opts: ClientOptions<M>) {
  const headers = { 'x-user-id': opts.userId }
  const collections: Record<string, Collection<Row, string>> = {}
  for (const table of opts.tables) {
    collections[table] = createCollection(
      electricCollectionOptions({
        id: table,
        shapeOptions: { url: `${opts.baseUrl}/api/shape/${table}`, headers },
        getKey: (row: Row) => row.id,
      }),
    ) as unknown as Collection<Row, string>
  }

  const read = (table: string, id: string) => collections[table]?.get(id)

  /**
   * Runs the mutator locally (the UI updates in the same tick), then sends it
   * to the server. The returned transaction settles once the server's write
   * has synced back; if the server rejects it, the local change rolls back.
   */
  async function mutate<K extends keyof M & string>(name: K, args: Input<M, K>): Promise<Transaction> {
    const mutator = opts.mutators[name]
    if (!mutator) throw new Error(`unknown mutator ${name}`)
    const input = await validate(mutator.input, args)
    const { tx, ops } = createRecordingTx(read)
    await mutator.run({ tx, input })

    const touched = [...new Set(ops.map((o) => o.table))]
    const transaction = createTransaction({
      autoCommit: false,
      mutationFn: async () => {
        const res = await fetch(`${opts.baseUrl}/api/mutate`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ name, args: input }),
        })
        const body = await res.json()
        if (!res.ok) throw new MutationRejected(body.error ?? res.statusText, res.status, body.code)
        await Promise.all(touched.map((t) => (collections[t] as any).utils.awaitTxId(body.txid)))
      },
    })
    transaction.mutate(() => ops.forEach(apply))
    transaction.commit().catch(() => {}) // errors surface through transaction.isPersisted
    return transaction
  }

  function apply(op: Op) {
    const c = collections[op.table]
    if (op.type === 'insert') c.insert(op.row)
    else if (op.type === 'update') c.update(op.id, (draft) => void Object.assign(draft, op.patch))
    else c.delete(op.id)
  }

  return {
    collections,
    mutate,
    ready: () => Promise.all(Object.values(collections).map((c) => c.preload())),
    close: () => Promise.all(Object.values(collections).map((c) => c.cleanup())),
  }
}

import type { ClientStorage } from './storage.ts'

/**
 * Client storage in IndexedDB, so a reload shows the last synced rows at once and sends the changes
 * that hadn't reached the server. Tabs of one origin share it.
 */
export function indexedDbStorage(name = 'bolide'): ClientStorage {
  let db: Promise<IDBDatabase> | undefined
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) => {
    const d = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction('kv', mode)
      const req = fn(tx.objectStore('kv'))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error)
    })
  }
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: async (key, value) => void (await run('readwrite', (s) => s.put(value, key))),
    delete: async (key) => void (await run('readwrite', (s) => s.delete(key))),
    async list(prefix) {
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('kv', 'readonly')
        const store = tx.objectStore('kv')
        const keys = store.getAllKeys(range)
        const values = store.getAll(range)
        tx.oncomplete = () => resolve(keys.result.map((k, i) => [String(k), values.result[i]]))
        tx.onerror = tx.onabort = () => reject(tx.error)
      })
    },
  }
}

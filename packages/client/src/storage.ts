/**
 * Where the client keeps synced rows and unsent mutations across reloads. Values are plain data
 * (structured-clone safe). `indexedDbStorage()` from `@bolide/client/idb` is the browser one.
 */
export interface ClientStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** Every entry whose key starts with `prefix`, in key order. */
  list(prefix: string): Promise<[string, unknown][]>
}

/** Keeps everything in a Map: for tests, and for code that shares one storage between clients. */
export function memoryStorage(): ClientStorage & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key) => structuredClone(data.get(key)),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async (key) => void data.delete(key),
    list: async (prefix) =>
      [...data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, structuredClone(v)]),
  }
}

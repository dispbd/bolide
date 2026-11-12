import type { StorageDriver } from './driver.ts'

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

export interface MemoryStorage extends StorageDriver {
  /** Stored keys, sorted. */
  keys(): string[]
}

/** Files in process memory, for tests and development. */
export function memoryStorage(): MemoryStorage {
  const files = new Map<string, { bytes: Uint8Array; contentType: string; lastModified: Date }>()
  const info = (f: { bytes: Uint8Array; contentType: string; lastModified: Date }) => ({ size: f.bytes.byteLength, contentType: f.contentType, lastModified: f.lastModified })
  return {
    async put(key, body, contentType) {
      files.set(key, { bytes: body.slice(), contentType, lastModified: new Date() })
    },
    async get(key) {
      const f = files.get(key)
      return f && { ...info(f), body: streamOf(f.bytes.slice()) }
    },
    async head(key) {
      const f = files.get(key)
      return f && info(f)
    },
    async delete(key) {
      files.delete(key)
    },
    keys: () => [...files.keys()].sort(),
  }
}

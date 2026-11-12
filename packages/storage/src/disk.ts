import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { BolideError } from '@bolide/core'
import type { StorageDriver } from './driver.ts'

/**
 * Files in a local directory. Content types are kept next to the files in `.meta/`
 * (keys can't start a segment with ".", so they never collide).
 */
export function diskStorage(root: string): StorageDriver {
  const base = resolve(root)
  const pathOf = (key: string, meta = false) => {
    const p = resolve(base, meta ? join('.meta', `${key}.json`) : key)
    // checkKey already rules out "..", but never trust one layer alone with the filesystem.
    if (!p.startsWith(base + sep)) throw new BolideError(`storage key "${key}" escapes the storage directory.`)
    return p
  }
  const missing = (e: unknown) => (e as { code?: string }).code === 'ENOENT'
  const head = async (key: string) => {
    try {
      const s = await stat(pathOf(key))
      if (!s.isFile()) return undefined
      const meta = await readFile(pathOf(key, true), 'utf8').then((t) => JSON.parse(t) as { contentType: string }, () => ({ contentType: 'application/octet-stream' }))
      return { size: s.size, contentType: meta.contentType, lastModified: s.mtime }
    } catch (e) {
      if (missing(e)) return undefined
      throw e
    }
  }
  return {
    async put(key, body, contentType) {
      const file = pathOf(key)
      const meta = pathOf(key, true)
      await mkdir(dirname(file), { recursive: true })
      await mkdir(dirname(meta), { recursive: true })
      // Write then rename, so readers never see half a file.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, body)
      await rename(tmp, file)
      await writeFile(meta, JSON.stringify({ contentType }))
    },
    async get(key) {
      const info = await head(key)
      if (!info) return undefined
      const body = Readable.toWeb(createReadStream(pathOf(key))) as unknown as ReadableStream<Uint8Array>
      return { ...info, body }
    },
    head,
    async delete(key) {
      await rm(pathOf(key), { force: true })
      await rm(pathOf(key, true), { force: true })
    },
  }
}

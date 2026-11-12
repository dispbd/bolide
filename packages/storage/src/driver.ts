import { BolideError, defineService } from '@bolide/core'
import { memoryStorage } from './memory.ts'

export interface FileInfo {
  size: number
  contentType: string
  lastModified: Date
}

export interface StoredFile extends FileInfo {
  body: ReadableStream<Uint8Array>
}

/** Where files live. Keys are already checked by `Storage` (see `checkKey`). */
export interface StorageDriver {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<StoredFile | undefined>
  head(key: string): Promise<FileInfo | undefined>
  delete(key: string): Promise<void>
  /** A URL a browser can fetch directly, valid for `expiresIn` seconds (S3 presigned URLs). */
  url?(key: string, expiresIn: number): Promise<string>
}

/**
 * Keys look like relative paths: `avatars/42.png`. No leading slash, no `.` or `..`
 * segments, no hidden segments, no backslashes or control characters, at most 512 bytes.
 * That keeps them safe as disk paths and as URL paths.
 */
export function checkKey(key: string): string {
  const bad = (why: string): never => {
    throw new BolideError(`storage key "${key}" ${why}. Use a relative path like "avatars/42.png".`)
  }
  if (typeof key !== 'string' || !key) bad('is empty')
  if (new TextEncoder().encode(key).length > 512) bad('is longer than 512 bytes')
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(key)) bad('has a backslash or a control character')
  if (key.startsWith('/')) bad('starts with a slash')
  for (const segment of key.split('/')) {
    if (!segment) bad('has an empty segment')
    if (segment.startsWith('.')) bad('has a segment starting with "."')
  }
  return key
}

/** The driver `Storage` uses: memory unless `storageModule({ driver })` picks another. */
export const StorageDriver = defineService<StorageDriver>({ name: 'StorageDriver', factory: () => memoryStorage() })

import { bind, BolideError, defineModule, defineService, HttpError, toMs, type Duration, type Module, type Service } from '@bolide/core'
import { checkKey, StorageDriver, type FileInfo, type StoredFile } from './driver.ts'

export type Body = Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>

export interface PutOptions {
  /** Default: the Blob's type, else a guess from the key's extension, else application/octet-stream. */
  contentType?: string
  /** Refuse bodies larger than this many bytes (HttpError 413). */
  maxSize?: number
}

export interface ServeOptions {
  /** Send as a download with this file name. */
  download?: string
  /**
   * Allow types a browser would run as a page (HTML, SVG, XML) to display inline.
   * Off by default: user uploads served from your origin could otherwise run scripts there.
   */
  inline?: boolean
  /** Default `private, max-age=0`. */
  cacheControl?: string
}

export interface Storage {
  put(key: string, body: Body, options?: PutOptions): Promise<FileInfo & { key: string }>
  get(key: string): Promise<StoredFile | undefined>
  bytes(key: string): Promise<Uint8Array | undefined>
  text(key: string): Promise<string | undefined>
  head(key: string): Promise<FileInfo | undefined>
  exists(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  /** A URL to fetch the file directly, when the driver can make one (S3). Default expiry 15m. */
  url(key: string, options?: { expiresIn?: Duration }): Promise<string>
  /** The file as a Response for a route handler, or a 404 HttpError. */
  response(key: string, options?: ServeOptions): Promise<Response>
}

const types: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8', xml: 'application/xml', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

export function guessType(key: string) {
  return types[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
}

const active = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml)\b/i

async function toBytes(body: Body, maxSize: number): Promise<Uint8Array> {
  const tooBig = () => new HttpError(413, `file exceeds ${maxSize} bytes`)
  if (typeof body === 'string') body = new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) body = new Uint8Array(body)
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxSize) throw tooBig()
    return body
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > maxSize) throw tooBig()
    return new Uint8Array(await body.arrayBuffer())
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxSize) {
      await reader.cancel().catch(() => {})
      throw tooBig()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

export function createStorage(driver: StorageDriver): Storage {
  const storage: Storage = {
    async put(key, body, options = {}) {
      checkKey(key)
      const bytes = await toBytes(body, options.maxSize ?? Infinity)
      const blobType = typeof Blob !== 'undefined' && body instanceof Blob ? body.type : ''
      const contentType = options.contentType || blobType || guessType(key)
      if (/[\r\n]/.test(contentType)) throw new BolideError(`content type "${contentType}" is not one line.`)
      await driver.put(key, bytes, contentType)
      return { key, size: bytes.byteLength, contentType, lastModified: new Date() }
    },
    get: (key) => driver.get(checkKey(key)),
    async bytes(key) {
      const f = await driver.get(checkKey(key))
      return f && new Uint8Array(await new Response(f.body).arrayBuffer())
    },
    async text(key) {
      const b = await storage.bytes(key)
      return b && new TextDecoder().decode(b)
    },
    head: (key) => driver.head(checkKey(key)),
    exists: async (key) => (await driver.head(checkKey(key))) !== undefined,
    delete: (key) => driver.delete(checkKey(key)),
    async url(key, options = {}) {
      checkKey(key)
      if (!driver.url) throw new BolideError('this storage driver has no direct URLs; serve the file with storage.response(key) from a route.')
      const seconds = Math.ceil(toMs(options.expiresIn ?? '15m', 'url expiresIn') / 1000)
      if (seconds < 1 || seconds > 604_800) throw new BolideError('url expiresIn must be between 1 second and 7 days.')
      return driver.url(key, seconds)
    },
    async response(key, options = {}) {
      const f = await driver.get(checkKey(key))
      if (!f) throw new HttpError(404, `file "${key}" not found`)
      const headers = new Headers({
        'content-type': f.contentType,
        'content-length': String(f.size),
        'last-modified': f.lastModified.toUTCString(),
        'x-content-type-options': 'nosniff',
        'cache-control': options.cacheControl ?? 'private, max-age=0',
      })
      const name = options.download ?? (!options.inline && active.test(f.contentType) ? key.slice(key.lastIndexOf('/') + 1) : undefined)
      if (name !== undefined) headers.set('content-disposition', `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      return new Response(f.body, { headers })
    },
  }
  return storage
}

export interface UploadOptions {
  /** The form field. Default `file`. */
  field?: string
  /** Max file size in bytes. Required: there is no sensible default. */
  maxSize: number
  /** Allowed content types, exact (`image/png`) or by family (`image/*`). Default: any. */
  types?: readonly string[]
}

/**
 * Reads one file from a `multipart/form-data` request. Use it in a route without a `body` schema:
 * `const file = await readUpload(ctx.request, { maxSize: 5_000_000, types: ['image/*'] })`.
 * Wrong form, missing file, size or type give 400, 413 or 415.
 */
export async function readUpload(request: Request, options: UploadOptions): Promise<File> {
  const field = options.field ?? 'file'
  if (!(options.maxSize > 0)) throw new BolideError('readUpload needs a positive maxSize.')
  if (!/^multipart\/form-data\b/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'upload must be multipart/form-data')
  }
  // The whole form is buffered by formData(), so refuse oversized requests before reading. Allow some room for the form's own parts.
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (declared > options.maxSize + 64 * 1024) throw new HttpError(413, `upload exceeds ${options.maxSize} bytes`)
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new HttpError(400, 'upload is not a valid multipart form')
  }
  const file = form.get(field)
  if (!(typeof file === 'object' && file !== null && 'arrayBuffer' in file)) throw new HttpError(400, `no file in form field "${field}"`)
  if (file.size > options.maxSize) throw new HttpError(413, `upload exceeds ${options.maxSize} bytes`)
  const type = file.type.split(';')[0]!.trim().toLowerCase()
  const allowed = options.types?.some((t) => (t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t.toLowerCase()))
  if (options.types && !allowed) throw new HttpError(415, `file type "${type || 'unknown'}" is not allowed`)
  return file as File
}

/** The app's file storage. Provide it with `storageModule()`. */
export const Storage = defineService({ name: 'Storage', inject: { driver: StorageDriver }, factory: ({ driver }): Storage => createStorage(driver) })

export interface StorageModuleOptions {
  /** A driver, or a service that builds one. Default: `memoryStorage()`. */
  driver?: StorageDriver | Service<StorageDriver, any>
  imports?: readonly Module[]
}

/** A global module providing `Storage` (and `StorageDriver`). */
export function storageModule(options: StorageModuleOptions = {}): Module {
  const d = options.driver
  const provider =
    d === undefined
      ? StorageDriver
      : bind(StorageDriver, typeof d === 'object' && (d as { kind?: unknown }).kind === 'service' ? { useService: d as Service<StorageDriver, any> } : { useValue: d as StorageDriver })
  return defineModule({ name: 'storage', global: true, imports: options.imports, providers: [provider, Storage], exports: [Storage, StorageDriver] })
}

import { createHash, createHmac } from 'node:crypto'
import { BolideError } from '@bolide/core'
import type { FileInfo, StorageDriver } from './driver.ts'

export interface S3Options {
  bucket: string
  /** e.g. `us-east-1`; `auto` for Cloudflare R2. */
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /**
   * For S3-compatible services (MinIO, R2, Backblaze...): `https://<account>.r2.cloudflarestorage.com`.
   * With an endpoint, paths are `/<bucket>/<key>`; without, AWS virtual-hosted URLs are used.
   */
  endpoint?: string
  /** Default 30s per request. */
  timeout?: number
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const encodePath = (path: string) => path.split('/').map(encode).join('/')

export interface SignInput {
  method: string
  url: URL
  /** Lower-case names. `host` is added from the URL. */
  headers: Record<string, string>
  payloadHash: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  /** `20130524T000000Z` */
  amzDate: string
}

function scope(i: Pick<SignInput, 'amzDate' | 'region' | 'service'>) {
  return `${i.amzDate.slice(0, 8)}/${i.region}/${i.service}/aws4_request`
}

function signature(i: SignInput, signedHeaders: string[], headers: Record<string, string>) {
  const query = [...i.url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = [
    i.method,
    // The URL's pathname is already percent-encoded once; that is what S3 signs.
    i.url.pathname,
    query,
    signedHeaders.map((h) => `${h}:${headers[h]!.trim().replace(/\s+/g, ' ')}\n`).join(''),
    signedHeaders.join(';'),
    i.payloadHash,
  ].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope(i), sha256(canonical)].join('\n')
  let key = hmac(`AWS4${i.secretAccessKey}`, i.amzDate.slice(0, 8))
  for (const part of [i.region, i.service, 'aws4_request']) key = hmac(key, part)
  return createHmac('sha256', key).update(toSign).digest('hex')
}

/** The `Authorization` header for a request signed with AWS Signature Version 4. */
export function signV4(i: SignInput): string {
  const headers: Record<string, string> = { ...i.headers, host: i.url.host }
  const signed = Object.keys(headers).sort()
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope(i)}, SignedHeaders=${signed.join(';')}, Signature=${signature(i, signed, headers)}`
}

/** A presigned URL (query-string authentication), valid for `expiresIn` seconds. */
export function presignV4(i: Omit<SignInput, 'headers' | 'payloadHash'> & { expiresIn: number; sessionToken?: string }): string {
  const url = new URL(i.url)
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Credential', `${i.accessKeyId}/${scope(i)}`)
  url.searchParams.set('X-Amz-Date', i.amzDate)
  url.searchParams.set('X-Amz-Expires', String(i.expiresIn))
  if (i.sessionToken) url.searchParams.set('X-Amz-Security-Token', i.sessionToken)
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  const sig = signature({ ...i, url, headers: {}, payloadHash: 'UNSIGNED-PAYLOAD' }, ['host'], { host: url.host })
  url.searchParams.set('X-Amz-Signature', sig)
  return url.toString()
}

const amzDate = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/**
 * Files in an S3 bucket or an S3-compatible service, signed with SigV4 over `fetch`
 * (no AWS SDK). Uploads are sent in one request, so they are held in memory.
 */
export function s3Storage(options: S3Options): StorageDriver {
  for (const k of ['bucket', 'region', 'accessKeyId', 'secretAccessKey'] as const) {
    if (!options[k]) throw new BolideError(`s3Storage needs ${k}.`)
  }
  const base = options.endpoint ? `${options.endpoint.replace(/\/$/, '')}/${encode(options.bucket)}` : `https://${options.bucket}.s3.${options.region}.amazonaws.com`
  const urlOf = (key: string) => new URL(`${base}/${encodePath(key)}`)

  const request = async (method: string, key: string, body?: Uint8Array, extra: Record<string, string> = {}) => {
    const url = urlOf(key)
    const payloadHash = body ? sha256(body) : EMPTY_SHA256
    const headers: Record<string, string> = {
      ...extra,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(),
      ...(options.sessionToken ? { 'x-amz-security-token': options.sessionToken } : {}),
    }
    headers.authorization = signV4({ method, url, headers, payloadHash, region: options.region, service: 's3', accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, amzDate: headers['x-amz-date']! })
    const res = await fetch(url, { method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(options.timeout ?? 30_000) })
    if (res.status === 404) {
      await res.body?.cancel()
      return undefined
    }
    if (!res.ok) throw new BolideError(`S3 ${method} ${key} failed with ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return res
  }
  const info = (res: Response): FileInfo => ({
    size: Number(res.headers.get('content-length') ?? 0),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    lastModified: new Date(res.headers.get('last-modified') ?? Date.now()),
  })

  return {
    async put(key, body, contentType) {
      const res = await request('PUT', key, body, { 'content-type': contentType })
      await res?.body?.cancel()
    },
    async get(key) {
      const res = await request('GET', key)
      return res && { ...info(res), body: res.body ?? new ReadableStream({ start: (c) => c.close() }) }
    },
    async head(key) {
      const res = await request('HEAD', key)
      return res && info(res)
    },
    async delete(key) {
      const res = await request('DELETE', key)
      await res?.body?.cancel()
    },
    async url(key, expiresIn) {
      return presignV4({
        method: 'GET',
        url: urlOf(key),
        region: options.region,
        service: 's3',
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken,
        amzDate: amzDate(),
        expiresIn,
      })
    },
  }
}

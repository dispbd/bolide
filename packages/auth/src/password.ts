import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export interface HashOptions {
  /** scrypt CPU/memory cost, a power of two. Default 2^15 (about 32 MiB, tens of ms). */
  cost?: number
  blockSize?: number
  parallelism?: number
}

const KEY_LENGTH = 32
const DEFAULTS = { cost: 2 ** 15, blockSize: 8, parallelism: 1 }

function derive(password: string, salt: Buffer, N: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) =>
    // maxmem must cover 128 * N * r bytes, or Node refuses large costs.
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (e, key) => (e ? reject(e) : resolve(key))),
  )
}

/** Hashes a password with scrypt and a random salt: `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string, options: HashOptions = {}): Promise<string> {
  const { cost: N, blockSize: r, parallelism: p } = { ...DEFAULTS, ...options }
  if (!Number.isInteger(Math.log2(N)) || N < 2) throw new RangeError(`cost must be a power of two, got ${N}.`)
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, r, p)
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

function parseHash(stored: string) {
  const [alg, N, r, p, salt, key, extra] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !key || extra !== undefined) return undefined
  const [n, rr, pp] = [N, r, p].map(Number) as [number, number, number]
  if (![n, rr, pp].every((v) => Number.isInteger(v) && v > 0) || n < 2 || (n & (n - 1)) !== 0) return undefined
  // Bounded so a tampered hash can't make verification allocate gigabytes (scrypt needs 128 * N * r bytes).
  if (n > 2 ** 20 || rr > 32 || pp > 16 || 128 * n * rr > 256 * 1024 * 1024) return undefined
  return { N: n, r: rr, p: pp, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') }
}

/** True when `password` matches `stored`. A malformed hash is a mismatch, not an error. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored)
  if (!h || h.key.length !== KEY_LENGTH) return false
  const key = await derive(password, h.salt, h.N, h.r, h.p)
  return timingSafeEqual(key, h.key)
}

/** True when `stored` was made with other parameters than `options`: rehash it after a successful login. */
export function needsRehash(stored: string, options: HashOptions = {}): boolean {
  const h = parseHash(stored)
  const want = { ...DEFAULTS, ...options }
  return !h || h.N !== want.cost || h.r !== want.blockSize || h.p !== want.parallelism
}

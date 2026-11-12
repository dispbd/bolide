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

// Shared by hashing and verifying, so a hash we store is always one we accept back.
// Bounded so a tampered hash can't make verification allocate gigabytes (scrypt needs 128 * N * r bytes).
function checkParams(N: number, r: number, p: number): string | undefined {
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return `cost, blockSize and parallelism must be positive integers, got ${N}, ${r}, ${p}.`
  if (N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0) return `cost must be a power of two from 2 to 2^20, got ${N}.`
  if (r > 32 || p > 16) return `blockSize must be at most 32 and parallelism at most 16, got ${r} and ${p}.`
  if (128 * N * r > 256 * 1024 * 1024) return `cost * blockSize needs ${(128 * N * r) / 2 ** 20} MiB; the limit is 256 MiB.`
  return undefined
}

/** Hashes a password with scrypt and a random salt: `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string, options: HashOptions = {}): Promise<string> {
  const { cost: N, blockSize: r, parallelism: p } = { ...DEFAULTS, ...options }
  const problem = checkParams(N, r, p)
  if (problem) throw new RangeError(`hashPassword: ${problem}`)
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, r, p)
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

function parseHash(stored: string) {
  const [alg, N, r, p, salt, key, extra] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !key || extra !== undefined) return undefined
  const [n, rr, pp] = [N, r, p].map(Number) as [number, number, number]
  if (checkParams(n, rr, pp)) return undefined
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

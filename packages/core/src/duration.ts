import { BolideError } from './errors.ts'

/** Milliseconds, or a number with a unit: `250ms`, `30s`, `5m`, `2h`, `7d`. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** Converts a Duration to milliseconds. Throws on negative, non-finite or malformed values. */
export function toMs(d: Duration, what = 'duration'): number {
  const m = typeof d === 'number' ? undefined : /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(d)
  const ms = typeof d === 'number' ? d : m ? Number(m[1]) * units[m[2] as keyof typeof units] : NaN
  if (!Number.isFinite(ms) || ms < 0) {
    throw new BolideError(`${what} must be a non-negative number of milliseconds or a string like "30s", "5m", "1h", got ${JSON.stringify(d)}.`)
  }
  return ms
}

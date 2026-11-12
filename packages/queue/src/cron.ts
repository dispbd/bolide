import { BolideError } from '@bolide/core'

/** A parsed cron expression. Times are UTC. */
export interface Cron {
  readonly source: string
  /** The first matching minute strictly after `after`. */
  next(after: Date): Date
}

const fields = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const macros: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

/**
 * Parses a five-field cron expression (minute hour day-of-month month day-of-week) in UTC.
 * Supports `*`, numbers, `a-b`, lists, steps (`*\/15`, `1-30/5`), month and day names
 * (`jan`, `mon`) and the macros `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.
 * When both day fields are restricted, a day matching either runs (as in Vixie cron).
 */
export function parseCron(expression: string): Cron {
  const source = expression.trim()
  const parts = (macros[source.toLowerCase()] ?? source).split(/\s+/)
  const fail = (why: string): never => {
    throw new BolideError(`cron "${expression}": ${why}. Use five fields: minute hour day-of-month month day-of-week, e.g. "*/15 * * * *".`)
  }
  if (parts.length !== 5) fail(`expected 5 fields, got ${parts.length}`)
  const sets = parts.map((part, i) => parseField(part, i, fail))
  const [minutes, hours, dom, monthsSet, dowRaw] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  // 7 is Sunday too.
  const dow = new Set([...dowRaw].map((d) => d % 7))
  const domAny = parts[2] === '*' || parts[2] === '?'
  const dowAny = parts[4] === '*' || parts[4] === '?'
  const dayMatches = (d: Date) => {
    const a = dom.has(d.getUTCDate())
    const b = dow.has(d.getUTCDay())
    if (domAny && dowAny) return true
    if (domAny) return b
    if (dowAny) return a
    return a || b
  }
  // With a day of week as well, the two are OR-ed and the job still runs on those weekdays.
  if (dowAny && ![...dom].some((d) => [...monthsSet].some((m) => d <= daysIn(m)))) fail('the day of month never occurs in the given months')

  return {
    source,
    next(after) {
      const t = new Date(after.getTime())
      t.setUTCSeconds(0, 0)
      t.setUTCMinutes(t.getUTCMinutes() + 1)
      // Bounded: any valid expression matches within a few years (Feb 29 needs up to 8).
      const limit = after.getTime() + 9 * 366 * 86_400_000
      while (t.getTime() <= limit) {
        if (!monthsSet.has(t.getUTCMonth() + 1)) {
          t.setUTCMonth(t.getUTCMonth() + 1, 1)
          t.setUTCHours(0, 0)
          continue
        }
        if (!dayMatches(t)) {
          t.setUTCDate(t.getUTCDate() + 1)
          t.setUTCHours(0, 0)
          continue
        }
        if (!hours.has(t.getUTCHours())) {
          t.setUTCHours(t.getUTCHours() + 1, 0)
          continue
        }
        if (!minutes.has(t.getUTCMinutes())) {
          t.setUTCMinutes(t.getUTCMinutes() + 1)
          continue
        }
        return t
      }
      throw new BolideError(`cron "${expression}" has no run time in the next 9 years.`)
    },
  }
}

function daysIn(month: number) {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}

function parseField(part: string, index: number, fail: (why: string) => never) {
  const { name, min, max } = fields[index]!
  const names = index === 3 ? months : index === 4 ? days : undefined
  const value = (s: string) => {
    const named = names?.indexOf(s.toLowerCase()) ?? -1
    const n = named >= 0 ? named + (index === 3 ? 1 : 0) : /^\d+$/.test(s) ? Number(s) : NaN
    if (!(n >= min && n <= max)) fail(`${name} "${s}" is not in ${min}-${max}`)
    return n
  }
  const out = new Set<number>()
  for (const item of part.split(',')) {
    const [range, stepText, extra] = item.split('/')
    if (extra !== undefined || range === undefined || range === '') fail(`bad ${name} "${item}"`)
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) && Number(stepText) > 0 ? Number(stepText) : fail(`bad step "${stepText}" in ${name}`)
    let from: number
    let to: number
    if (range === '*' || range === '?') {
      if (range === '?' && index !== 2 && index !== 4) fail(`"?" is only allowed in the day fields`)
      ;[from, to] = [min, index === 4 ? 6 : max]
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      ;[from, to] = [value(a!), value(b!)]
      if (from > to) fail(`${name} range "${range}" runs backwards`)
    } else {
      from = value(range!)
      to = stepText === undefined ? from : index === 4 ? 6 : max
    }
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return out
}

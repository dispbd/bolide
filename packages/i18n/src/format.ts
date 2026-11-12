import { BolideError } from '@bolide/core'

/**
 * A subset of ICU MessageFormat:
 * - `{name}` inserts a value (numbers and dates are formatted for the locale),
 * - `{n, number}`, `{d, date}`, `{d, time}`,
 * - `{n, plural, =0 {none} one {# item} other {# items}}` (`#` is the formatted number),
 * - `{g, select, female {She} male {He} other {They}}`.
 * Write `'{'` for a literal brace and `''` for a quote.
 */
type Part =
  | string
  | { kind: 'arg'; name: string; style?: 'number' | 'date' | 'time' }
  | { kind: 'plural'; name: string; cases: Record<string, Part[]> }
  | { kind: 'select'; name: string; cases: Record<string, Part[]> }
  | { kind: 'hash' }

export type Compiled = Part[]

export function compile(message: string, where = 'message'): Compiled {
  let i = 0
  const fail = (why: string): never => {
    throw new BolideError(`${where}: ${why} at position ${i} in "${message}".`)
  }

  const parseText = (inPlural: boolean, nested: boolean): Part[] => {
    const parts: Part[] = []
    let text = ''
    while (i < message.length) {
      const c = message[i]!
      if (c === "'") {
        if (message[i + 1] === "'") {
          text += "'"
          i += 2
          continue
        }
        const end = message.indexOf("'", i + 1)
        if (end > i + 1 && /^[{}#]/.test(message[i + 1]!)) {
          text += message.slice(i + 1, end)
          i = end + 1
          continue
        }
        text += c
        i++
        continue
      }
      if (c === '{') {
        if (text) parts.push(text)
        text = ''
        parts.push(parseArg())
        continue
      }
      if (c === '}') {
        if (!nested) fail('unmatched "}"')
        break
      }
      if (c === '#' && inPlural) {
        if (text) parts.push(text)
        text = ''
        parts.push({ kind: 'hash' })
        i++
        continue
      }
      text += c
      i++
    }
    if (text) parts.push(text)
    return parts
  }

  const skipSpace = () => {
    while (/\s/.test(message[i] ?? '')) i++
  }
  const word = () => {
    skipSpace()
    const m = /^[^\s{},]+/.exec(message.slice(i))
    if (!m) fail('expected a name')
    i += m![0].length
    skipSpace()
    return m![0]
  }

  const parseArg = (): Part => {
    i++ // {
    const name = word()
    if (!/^[A-Za-z_][\w]*$/.test(name)) fail(`"${name}" is not a valid argument name`)
    if (message[i] === '}') {
      i++
      return { kind: 'arg', name }
    }
    if (message[i] !== ',') fail('expected "," or "}"')
    i++
    const type = word()
    if (message[i] === '}' && (type === 'number' || type === 'date' || type === 'time')) {
      i++
      return { kind: 'arg', name, style: type }
    }
    if (type !== 'plural' && type !== 'select') fail(`unknown argument type "${type}" (use number, date, time, plural or select)`)
    if (message[i] !== ',') fail('expected ","')
    i++
    const cases: Record<string, Part[]> = {}
    skipSpace()
    while (message[i] !== '}') {
      if (i >= message.length) fail('unclosed "{"')
      const key = word()
      if (message[i] !== '{') fail(`expected "{" after "${key}"`)
      i++
      cases[key] = parseText(type === 'plural', true)
      if (message[i] !== '}') fail('unclosed case')
      i++
      skipSpace()
    }
    i++
    if (!cases.other) fail(`${type} needs an "other" case`)
    return { kind: type as 'plural' | 'select', name, cases }
  }

  const parts = parseText(false, false)
  return parts
}

export type Value = string | number | Date

export interface FormatContext {
  locale: string
  number(n: number): string
  date(d: Date | number, style: 'date' | 'time'): string
  plural(n: number): string
}

export function render(parts: Compiled, values: Record<string, Value>, ctx: FormatContext, where: string, hash?: number): string {
  let out = ''
  for (const p of parts) {
    if (typeof p === 'string') {
      out += p
      continue
    }
    if (p.kind === 'hash') {
      out += hash === undefined ? '#' : ctx.number(hash)
      continue
    }
    if (!(p.name in values)) throw new BolideError(`${where}: missing value for {${p.name}}.`)
    const v = values[p.name]!
    if (p.kind === 'arg') {
      if (p.style === 'number' || (!p.style && typeof v === 'number')) out += ctx.number(Number(v))
      else if (p.style === 'date' || p.style === 'time' || v instanceof Date) out += ctx.date(v instanceof Date || typeof v === 'number' ? v : new Date(v), p.style === 'time' ? 'time' : 'date')
      else out += String(v)
      continue
    }
    if (p.kind === 'plural') {
      const n = Number(v)
      const exact = p.cases[`=${n}`]
      out += render(exact ?? p.cases[ctx.plural(n)] ?? p.cases.other!, values, ctx, where, n)
      continue
    }
    out += render(p.cases[String(v)] ?? p.cases.other!, values, ctx, where, hash)
  }
  return out
}

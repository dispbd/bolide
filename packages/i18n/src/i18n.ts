import { BolideError, CurrentRequest, defineModule, defineService, Log, type Service } from '@bolide/core'
import { argNames, compile, render, type Compiled, type FormatContext, type Value } from './format.ts'

/** Messages, nested by topic: `{ nav: { home: 'Home' }, cart: { items: '{count, plural, one {# item} other {# items}}' } }`. */
export type Catalog = { readonly [key: string]: string | Catalog }

/** Dotted keys of a catalog's messages: `'nav.home' | 'cart.items'`. */
export type MessageKey<C> = {
  [K in keyof C & string]: C[K] extends string ? K : `${K}.${MessageKey<C[K]>}`
}[keyof C & string]

type At<C, K extends string> = K extends `${infer H}.${infer R}` ? (H extends keyof C ? At<C[H], R> : never) : K extends keyof C ? C[K] : never

type Trim<S extends string> = S extends ` ${infer R}` ? Trim<R> : S extends `${infer R} ` ? Trim<R> : S
type NameAt<R extends string> = R extends `${infer N}}${string}` ? (N extends `${infer M},${string}` ? Trim<M> : Trim<N>) : never
type Even = 0 | 2 | 4 | 6 | 8
/**
 * Argument names in an ICU message: `'Hi {name}, {n, plural, one {# of {total}} other {...}}'` gives
 * `'name' | 'n' | 'total'`. A brace opens an argument at even nesting depth and a case body at odd depth;
 * quoted braces are text.
 */
export type ArgNames<S extends string, D extends unknown[] = [], Acc extends string = never> = S extends `'${infer R}`
  ? R extends `'${infer R2}`
    ? ArgNames<R2, D, Acc>
    : R extends `${'{' | '}' | '#'}${string}`
      ? R extends `${string}'${infer After}`
        ? ArgNames<After, D, Acc>
        : Acc
      : ArgNames<R, D, Acc>
  : S extends `{${infer R}`
    ? ArgNames<R, [...D, 1], D['length'] extends Even ? Acc | NameAt<R> : Acc>
    : S extends `}${infer R}`
      ? ArgNames<R, D extends [unknown, ...infer Rest] ? Rest : [], Acc>
      : S extends `${string}${infer R}`
        ? ArgNames<R, D, Acc>
        : Acc

/** The values a message needs, or nothing when it has no arguments. */
export type MessageArgs<S> = S extends string
  ? string extends S
    ? [values?: Record<string, Value>]
    : [ArgNames<S>] extends [never]
      ? []
      : [values: Record<ArgNames<S>, Value>]
  : never

/** The same keys with any strings: what a translation must look like. */
export type Translation<C> = { readonly [K in keyof C]?: C[K] extends string ? string : Translation<C[K]> }

export interface Translator<C extends Catalog> {
  readonly locale: string
  t<K extends MessageKey<C>>(key: K, ...args: MessageArgs<At<C, K>>): string
  number(n: number, options?: Intl.NumberFormatOptions): string
  date(d: Date | number, options?: Intl.DateTimeFormatOptions): string
}

export interface I18n<C extends Catalog> {
  readonly defaultLocale: string
  readonly locales: readonly string[]
  /** A translator for a locale (a supported one, else the default). */
  in(locale: string): Translator<C>
  /** The best supported locale for a language tag or an Accept-Language header, or undefined. */
  match(tags: string): string | undefined
}

export type Detector = 'query' | 'cookie' | 'header'

export interface I18nOptions<C extends Catalog> {
  defaultLocale: string
  /** The default locale's catalog. Keys and argument names are inferred from it (inline it or add `as const`). */
  messages: C
  /** Other locales. Missing messages fall back to the default locale; they are listed at boot. */
  translations?: Readonly<Record<string, Translation<C>>>
  /** Where the request's locale comes from, in order. Default: query `?lang=`, cookie `lang`, then Accept-Language. */
  detect?: readonly Detector[]
  queryParam?: string
  cookieName?: string
}

function flatten(c: Catalog, prefix = '', out = new Map<string, string>()) {
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'string') out.set(prefix + k, v)
    else flatten(v, `${prefix}${k}.`, out)
  }
  return out
}

function canonical(tag: string) {
  try {
    return Intl.getCanonicalLocales(tag)[0]
  } catch {
    return undefined
  }
}

/**
 * Defines the app's messages and returns a module plus two typed tokens:
 * `I18n` (singleton) and `T` (request-scoped, in the request's locale).
 *
 * ```ts
 * export const { i18nModule, T } = defineI18n({
 *   defaultLocale: 'en',
 *   messages: { hello: 'Hello, {name}!', cart: { items: '{count, plural, one {# item} other {# items}}' } },
 *   translations: { ru: { hello: 'Привет, {name}!' } },
 * })
 * // in a route that injects { t: T }:  t.t('cart.items', { count: 3 })
 * ```
 */
export function defineI18n<const C extends Catalog>(options: I18nOptions<C>) {
  const defaultLocale = canonical(options.defaultLocale) ?? fail(`defaultLocale "${options.defaultLocale}" is not a valid language tag.`)
  const compiled = new Map<string, Map<string, Compiled>>()
  const base = flatten(options.messages)
  const compileAll = (locale: string, flat: Map<string, string>) => {
    const m = new Map<string, Compiled>()
    const baseParts = compiled.get(defaultLocale)
    for (const [k, v] of flat) {
      const parts = compile(v, `i18n ${locale} "${k}"`)
      // Callers pass the arguments the default message names, so a translation can't ask for others.
      if (baseParts) {
        const known = argNames(baseParts.get(k)!)
        const extra = [...argNames(parts)].filter((a) => !known.has(a))
        if (extra.length) fail(`translation ${locale} "${k}" uses {${extra.join('}, {')}}, which the ${defaultLocale} message doesn't have.`)
      }
      m.set(k, parts)
    }
    compiled.set(locale, m)
  }
  compileAll(defaultLocale, base)
  const missing: Record<string, string[]> = {}
  for (const [tag, translation] of Object.entries(options.translations ?? {})) {
    const locale = canonical(tag) ?? fail(`translation locale "${tag}" is not a valid language tag.`)
    const flat = flatten(translation as Catalog)
    for (const k of flat.keys()) if (!base.has(k)) fail(`translation ${locale} has "${k}", which is not in the ${defaultLocale} messages.`)
    const gaps = [...base.keys()].filter((k) => !flat.has(k))
    if (gaps.length) missing[locale] = gaps
    compileAll(locale, flat)
  }
  const locales = [...compiled.keys()]
  const detect = options.detect ?? ['query', 'cookie', 'header']
  const queryParam = options.queryParam ?? 'lang'
  const cookieName = options.cookieName ?? 'lang'

  const match = (tags: string): string | undefined => {
    // Accept-Language: "ru-RU,ru;q=0.9,en;q=0.8"; a plain tag works too.
    const wanted = tags
      .split(',')
      .map((part, i) => {
        const [tag, ...params] = part.trim().split(';')
        const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)).find(Boolean)
        return { tag: tag!.trim(), q: q ? Number(q[1]) : 1, i }
      })
      .filter((w) => w.tag && w.q > 0)
      .sort((a, b) => b.q - a.q || a.i - b.i)
    for (const { tag } of wanted) {
      if (tag === '*') return defaultLocale
      const c = canonical(tag)
      if (!c) continue
      const exact = locales.find((l) => l.toLowerCase() === c.toLowerCase())
      if (exact) return exact
      const lang = c.split('-')[0]!.toLowerCase()
      const near = locales.find((l) => l.split('-')[0]!.toLowerCase() === lang)
      if (near) return near
    }
    return undefined
  }

  const translators = new Map<string, Translator<C>>()
  const translator = (locale: string): Translator<C> => {
    const cached = translators.get(locale)
    if (cached) return cached
    const plural = new Intl.PluralRules(locale)
    const numbers = new Intl.NumberFormat(locale)
    const ctx: FormatContext = {
      locale,
      number: (n) => numbers.format(n),
      date: (d, style) => new Intl.DateTimeFormat(locale, style === 'time' ? { timeStyle: 'short' } : { dateStyle: 'medium' }).format(d),
      plural: (n) => plural.select(n),
    }
    const own = compiled.get(locale)!
    const fallback = compiled.get(defaultLocale)!
    const t: Translator<C> = {
      locale,
      t: (key: string, ...args: [Record<string, Value>?]) => {
        const parts = own.get(key) ?? fallback.get(key)
        if (!parts) throw new BolideError(`i18n: no message "${key}".`)
        return render(parts, args[0] ?? {}, ctx, `i18n ${locale} "${key}"`)
      },
      number: (n, o) => (o ? new Intl.NumberFormat(locale, o).format(n) : numbers.format(n)),
      date: (d, o) => new Intl.DateTimeFormat(locale, o ?? { dateStyle: 'medium' }).format(d),
    } as Translator<C>
    translators.set(locale, t)
    return t
  }

  const i18n: I18n<C> = {
    defaultLocale,
    locales,
    in: (locale) => translator(match(locale) ?? defaultLocale),
    match,
  }

  const I18nToken: Service<I18n<C>, {}> = defineService({ name: 'I18n', factory: () => i18n })
  const CurrentLocale = defineService({
    name: 'CurrentLocale',
    scope: 'request',
    inject: { request: CurrentRequest },
    factory: ({ request }): string => {
      for (const d of detect) {
        let found: string | undefined
        if (d === 'query') {
          const q = new URL(request.url).searchParams.get(queryParam)
          found = q ? match(q) : undefined
        } else if (d === 'cookie') {
          const c = /(?:^|;\s*)([^=;]+)=([^;]*)/g
          for (const m of (request.headers.get('cookie') ?? '').matchAll(c)) if (m[1]!.trim() === cookieName) found = match(safeDecode(m[2]!))
        } else {
          const h = request.headers.get('accept-language')
          found = h ? match(h) : undefined
        }
        if (found) return found
      }
      return defaultLocale
    },
  })
  const T = defineService({
    name: 'T',
    scope: 'request',
    inject: { locale: CurrentLocale },
    factory: ({ locale }): Translator<C> => translator(locale),
  })
  // Untranslated messages are reported once at boot, through the app's logger.
  const report = defineService({
    name: 'I18nMissing',
    inject: { log: Log },
    factory: ({ log }) => {
      for (const [locale, keys] of Object.entries(missing)) log.warn(`i18n: ${locale} is missing ${keys.length} message(s), the ${defaultLocale} ones are used`, { locale, keys })
    },
  })
  return {
    i18nModule: defineModule({ name: 'i18n', global: true, providers: [I18nToken, CurrentLocale, T, report], exports: [I18nToken, CurrentLocale, T] }),
    I18n: I18nToken,
    CurrentLocale,
    T,
    /** The singleton, usable outside the container (scripts, tests). */
    i18n,
    /** Untranslated keys per locale. */
    missing,
  }
}

// A malformed cookie (`lang=%E0`) is ignored, not a 500.
function safeDecode(v: string) {
  try {
    return decodeURIComponent(v)
  } catch {
    return ''
  }
}

function fail(why: string): never {
  throw new BolideError(`defineI18n: ${why}`)
}

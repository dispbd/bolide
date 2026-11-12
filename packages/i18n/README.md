# @bolide/i18n

Translations for Bolide apps with types inferred from your messages: a typo in a key or a missing argument is a compile error. Messages use a subset of ICU MessageFormat, plurals follow each language's rules (through `Intl`), and each request gets its locale from the query, a cookie or `Accept-Language`.

```ts
import { defineI18n } from '@bolide/i18n'

export const { i18nModule, T, I18n } = defineI18n({
  defaultLocale: 'en',
  messages: {
    hello: 'Hello, {name}!',
    cart: { items: 'You have {count, plural, =0 {no items} one {# item} other {# items}}.' },
  },
  translations: {
    ru: {
      hello: 'Привет, {name}!',
      cart: { items: 'У вас {count, plural, =0 {нет товаров} one {# товар} few {# товара} many {# товаров} other {# товара}}.' },
    },
  },
})

const cart = defineRoute({
  method: 'GET',
  path: '/cart',
  inject: { t: T },
  handler: (_c, { t }) => ({ title: t.t('cart.items', { count: 3 }) }),
})

createApp({ modules: [i18nModule, shop] })
```

## Messages

- `{name}` inserts a value; numbers and dates are formatted for the locale. `{n, number}`, `{d, date}`, `{d, time}` force a style.
- `{n, plural, =0 {...} one {...} few {...} other {...}}`: `#` is the formatted number; exact `=N` cases win; categories come from `Intl.PluralRules`.
- `{g, select, female {...} other {...}}`.
- `'{'` is a literal brace and `''` a quote. Every plural and select needs `other`.

Keys are dotted paths into the nested catalog (`cart.items`). Argument names are read from the default messages at compile time, so write them inline in `defineI18n` or add `as const` when they come from another file. Malformed messages fail when `defineI18n` runs.

## Translations

Translations follow the default catalog's shape. A message missing from a translation falls back to the default locale, and each locale's gaps are logged once at boot (and listed in `missing`). A key that isn't in the default catalog fails at definition.

## Locales

`T` (request-scoped) translates into the request's locale, found in order by `detect` (default `['query', 'cookie', 'header']`): `?lang=ru`, a `lang` cookie, then `Accept-Language` with its weights. Regional tags match their language (`ru-RU` finds `ru`, `pt` finds `pt-BR`); anything unsupported falls through to the next source and finally to the default locale. `T` also has `number(n, options)` and `date(d, options)`.

`I18n` (singleton) and the returned `i18n` object work outside requests: `i18n.in('ru').t('hello', { name })` for mail and jobs, `i18n.match(header)` to pick a locale yourself.

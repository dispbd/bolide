import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, createLogger, defineModule, defineRoute, type LogRecord } from '@bolide/core'
import { compile, defineI18n } from '../src/index.ts'

const make = () =>
  defineI18n({
    defaultLocale: 'en',
    messages: {
      hello: 'Hello, {name}!',
      plain: 'Just text',
      cart: {
        items: 'You have {count, plural, =0 {no items} one {# item} other {# items}}.',
        total: 'Total: {sum, number}',
      },
      who: '{gender, select, female {She} male {He} other {They}} liked it',
      quoted: "It''s '{literal}'",
    },
    translations: {
      ru: {
        hello: 'Привет, {name}!',
        cart: { items: 'У вас {count, plural, =0 {нет товаров} one {# товар} few {# товара} many {# товаров} other {# товара}}.' },
      },
      'pt-BR': { plain: 'Só texto' },
    },
  })

describe('messages', () => {
  test('arguments, plurals per locale, select, numbers and quotes', () => {
    const { i18n } = make()
    const en = i18n.in('en')
    assert.equal(en.t('hello', { name: 'Ann' }), 'Hello, Ann!')
    assert.equal(en.t('plain'), 'Just text')
    assert.equal(en.t('cart.items', { count: 0 }), 'You have no items.')
    assert.equal(en.t('cart.items', { count: 1 }), 'You have 1 item.')
    assert.equal(en.t('cart.items', { count: 1200 }), 'You have 1,200 items.')
    assert.equal(en.t('cart.total', { sum: 1234.5 }), 'Total: 1,234.5')
    assert.equal(en.t('who', { gender: 'female' }), 'She liked it')
    assert.equal(en.t('who', { gender: 'x' }), 'They liked it')
    assert.equal(en.t('quoted'), "It's {literal}")
    const ru = i18n.in('ru')
    assert.deepEqual([1, 3, 5, 21].map((count) => ru.t('cart.items', { count })), ['У вас 1 товар.', 'У вас 3 товара.', 'У вас 5 товаров.', 'У вас 21 товар.'])
    assert.equal(ru.t('cart.total', { sum: 1234.5 }), 'Total: 1 234,5', 'missing messages fall back, formatted for the locale')
  })

  test('arguments and keys are checked by the compiler', () => {
    const { i18n } = make()
    const en = i18n.in('en')
    // @ts-expect-error missing the name argument
    assert.throws(() => en.t('hello'), /missing value for \{name\}/)
    // @ts-expect-error unknown key
    assert.throws(() => en.t('cart.nope'), /no message "cart.nope"/)
    // @ts-expect-error wrong argument name
    assert.throws(() => en.t('hello', { nam: 'x' }), /missing value/)
    // @ts-expect-error a message without arguments takes none
    en.t('plain', { x: 1 })
  })

  test('bad messages and translations fail at definition', () => {
    assert.throws(() => compile('{n, plural, one {x}}'), /needs an "other" case/)
    assert.throws(() => compile('{n, money}'), /unknown argument type "money"/)
    assert.throws(() => compile('a } b'), /unmatched "}"/)
    assert.throws(() => compile('{n, plural, other {x}'), /unclosed/)
    assert.throws(() => defineI18n({ defaultLocale: 'en', messages: { a: 'A' }, translations: { de: { b: 'B' } as never } }), /translation de has "b"/)
    assert.throws(() => defineI18n({ defaultLocale: 'not a tag!', messages: {} }), /not a valid language tag/)
    assert.throws(() => defineI18n({ defaultLocale: 'en', messages: { a: 'Hi {name}' }, translations: { de: { a: 'Hallo {nam}' } } }), /translation de "a" uses \{nam\}/)
    assert.throws(() => defineI18n({ defaultLocale: 'en', messages: { a: '{n, plural, other {#}}' }, translations: { de: { a: '{n, plural, other {# {x}}}' } } }), /uses \{x\}/)
    defineI18n({ defaultLocale: 'en', messages: { a: 'Hi {name}' }, translations: { de: { a: 'Hallo' } } })
  })
})

describe('locale detection', () => {
  test('match understands Accept-Language with weights and regional variants', () => {
    const { i18n } = make()
    assert.equal(i18n.match('ru-RU,ru;q=0.9,en;q=0.8'), 'ru')
    assert.equal(i18n.match('de;q=1, pt;q=0.5'), 'pt-BR')
    assert.equal(i18n.match('fr, en;q=0.1'), 'en')
    assert.equal(i18n.match('fr'), undefined)
    assert.equal(i18n.match('*'), 'en')
    assert.equal(i18n.in('xx').locale, 'en')
  })

  test('T follows the query, then the cookie, then Accept-Language', async () => {
    const { i18nModule, T } = make()
    const route = defineRoute({ method: 'GET', path: '/hi', inject: { t: T }, handler: (_c, { t }) => ({ locale: t.locale, text: t.t('hello', { name: 'Bo' }) }) })
    const records: LogRecord[] = []
    const app = await createApp({ modules: [i18nModule, defineModule({ name: 'm', routes: [route] })], logger: createLogger({ write: (r) => void records.push(r) }) })
    const get = async (path: string, headers: Record<string, string> = {}) => (await (await app.fetch(new Request(`http://x${path}`, { headers }))).json()).text
    assert.equal(await get('/hi'), 'Hello, Bo!')
    assert.equal(await get('/hi', { 'accept-language': 'ru-RU,ru;q=0.9' }), 'Привет, Bo!')
    assert.equal(await get('/hi', { 'accept-language': 'ru', cookie: 'a=1; lang=en' }), 'Hello, Bo!')
    assert.equal(await get('/hi?lang=ru', { cookie: 'lang=en' }), 'Привет, Bo!')
    assert.equal(await get('/hi?lang=zz', { 'accept-language': 'ru' }), 'Привет, Bo!', 'unsupported values fall through')
    assert.equal(await get('/hi', { cookie: 'lang=%E0', 'accept-language': 'ru' }), 'Привет, Bo!', 'a malformed cookie is ignored')
    const warn = records.find((r) => r.msg.startsWith('i18n: ru is missing'))!
    assert.deepEqual(warn.fields.keys, ['plain', 'cart.total', 'who', 'quoted'])
  })
})

// Compile-time: argument names extracted from ICU messages.
import type { ArgNames } from '../src/index.ts'
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const argChecks: [
  Eq<ArgNames<'Hi {name}!'>, 'name'>,
  Eq<ArgNames<'{n, plural, one {# of {total}} other {# of {total} by {who}}}'>, 'n' | 'total' | 'who'>,
  Eq<ArgNames<'{g, select, female {She} other {They}}'>, 'g'>,
  Eq<ArgNames<"It''s '{x}' {y}">, 'y'>,
  Eq<ArgNames<'{ spaced }'>, 'spaced'>,
  Eq<ArgNames<'none'>, never>,
] = [true, true, true, true, true, true]
void argChecks

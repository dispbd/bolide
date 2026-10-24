// Minified + gzipped size of each entry, bundled for the browser (or Node for the server).
import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'

const entries = [
  ['Клиент Crucible целиком (TanStack DB + Electric + zod + мутаторы)', 'crucible-client', 'browser'],
  ['  из них TanStack DB + electric-collection', 'tanstack-electric', 'browser'],
  ['  из них @electric-sql/client', 'electric-client', 'browser'],
  ['  из них zod (одна схема)', 'zod', 'browser'],
  ['  для сравнения: zod/mini (та же схема)', 'zod-mini', 'browser'],
  ['Сервер Crucible (Hono + наш код, без драйвера postgres)', 'hono-server', 'node'],
]
console.log('| Бандл | min, КБ | min+gzip, КБ |\n|---|---|---|')
for (const [label, name, platform] of entries) {
  const r = await build({
    entryPoints: [`spike/bench/entries/${name}.ts`],
    bundle: true, minify: true, write: false, format: 'esm', platform,
    external: platform === 'node' ? ['postgres'] : [],
    logLevel: 'silent',
  })
  const code = r.outputFiles[0].contents
  const kb = (n) => (n / 1024).toFixed(1)
  console.log(`| ${label} | ${kb(code.length)} | ${kb(gzipSync(code).length)} |`)
}

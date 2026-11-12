// Minified + gzipped size of each entry, bundled for the browser (or Node for the server).
import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'

const entries = [
  ['Full Bolide client (TanStack DB + Electric + zod + mutators)', 'bolide-client', 'browser'],
  ['  of which TanStack DB + electric-collection', 'tanstack-electric', 'browser'],
  ['  of which @electric-sql/client', 'electric-client', 'browser'],
  ['  of which zod (one schema)', 'zod', 'browser'],
  ['  for comparison: zod/mini (same schema)', 'zod-mini', 'browser'],
  ['Bolide server (Hono + our code, without the postgres driver)', 'hono-server', 'node'],
]
console.log('| Bundle | min, KB | min+gzip, KB |\n|---|---|---|')
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

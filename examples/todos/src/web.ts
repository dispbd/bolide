import { fileURLToPath } from 'node:url'
import { defineModule, defineRoute } from '@bolide/core'
import * as esbuild from 'esbuild'
import { newUserCookie, userIdFrom } from './user.ts'

const production = process.env.NODE_ENV === 'production'
const entry = fileURLToPath(new URL('./client/main.tsx', import.meta.url))

// esbuild bundles the browser code on request: in development every reload gets fresh code (an incremental
// rebuild takes milliseconds), in production it is built once and kept.
let context: Promise<esbuild.BuildContext<{ write: false }>> | undefined
let built: Promise<string> | undefined
async function rebuild() {
  context ??= esbuild.context({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    minify: production,
    sourcemap: production ? false : 'inline',
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    logLevel: 'silent',
  })
  const result = await (await context).rebuild()
  return result.outputFiles[0]!.text
}
const bundle = () => (production ? (built ??= rebuild()) : rebuild())

const page = (userId: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="user-id" content="${userId}">
  <title>Todos</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
    form { display: flex; gap: .5rem; }
    form input { flex: 1; }
    input, button { font: inherit; padding: .4rem .6rem; }
    ul { list-style: none; padding: 0; }
    li { display: flex; align-items: center; gap: .5rem; padding: .35rem 0; border-bottom: 1px solid #8884; }
    li span { flex: 1; }
    li.done span { text-decoration: line-through; opacity: .6; }
    li button { border: 0; background: none; cursor: pointer; opacity: .5; }
    .error { color: #c33; }
    .muted { opacity: .6; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
`

const index = defineRoute({
  method: 'GET',
  path: '/',
  summary: 'The app',
  handler: ({ request }) => {
    const known = userIdFrom(request)
    const userId = known ?? crypto.randomUUID()
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (!known) headers.set('set-cookie', newUserCookie(userId, new URL(request.url).protocol === 'https:'))
    return new Response(page(userId), { headers })
  },
})

const script = defineRoute({
  method: 'GET',
  path: '/app.js',
  summary: 'The browser bundle',
  handler: async () =>
    new Response(await bundle(), {
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': production ? 'public, max-age=300' : 'no-store' },
    }),
})

export const WebModule = defineModule({ name: 'web', routes: [index, script] })

/** Stops esbuild's background service, so the process can exit. */
export async function stopBundler() {
  const c = context
  context = undefined
  built = undefined
  await (await c)?.dispose()
}

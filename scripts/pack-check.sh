#!/usr/bin/env bash
# Packs @bolide/core, @bolide/cli and the batteries, installs them into a project made by
# `bolide create` (as a user would, from tarballs), then typechecks and tests it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$root"
npm run build --silent
npm pack -w @bolide/core -w @bolide/cli -w @bolide/cache -w @bolide/queue -w @bolide/auth -w @bolide/mail -w @bolide/storage -w @bolide/i18n -w @bolide/data -w @bolide/client --pack-destination "$work" --silent >/dev/null
node packages/cli/bin/bolide.mjs create "$work/app" >/dev/null
cd "$work/app"
node -e "
const fs = require('fs')
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tgz = (name) => 'file:../' + fs.readdirSync('..').find((f) => f.startsWith('bolide-' + name + '-'))
p.dependencies['@bolide/core'] = tgz('core')
p.devDependencies['@bolide/cli'] = tgz('cli')
p.dependencies['@bolide/cache'] = tgz('cache')
p.dependencies['@bolide/queue'] = tgz('queue')
p.dependencies['@bolide/auth'] = tgz('auth')
p.dependencies['@bolide/mail'] = tgz('mail')
p.dependencies['@bolide/storage'] = tgz('storage')
p.dependencies['@bolide/i18n'] = tgz('i18n')
p.dependencies['@bolide/data'] = tgz('data')
p.dependencies['@bolide/client'] = tgz('client')
fs.writeFileSync('package.json', JSON.stringify(p, null, 2))
"
npm install --silent
# Types from dist/*.d.ts must be real, not silently any.
cat > src/types-check.ts <<'TS'
import { defineService } from '@bolide/core'
import { Cache, cacheModule } from '@bolide/cache'
const s = defineService({ name: 'x', factory: () => 1 })
// @ts-expect-error name is a string
export const n: number = s.name
export const m = cacheModule({ ttl: '5m' })
defineService({ name: 'y', inject: { cache: Cache }, factory: async ({ cache }) => {
  // @ts-expect-error ttl must be a Duration
  await cache.set('k', 1, { ttl: '5 minutes' })
  return cache.wrap('k', () => 1)
} })
import { defineI18n } from '@bolide/i18n'
const { i18n } = defineI18n({ defaultLocale: 'en', messages: { hi: 'Hi {name}' } })
i18n.in('en').t('hi', { name: 'x' })
// @ts-expect-error the message needs a name
i18n.in('en').t('hi')
import { defineJob, Queue } from '@bolide/queue'
const Ping = defineJob({ name: 'ping', handler: () => {} })
defineService({ name: 'z', inject: { queue: Queue }, factory: async ({ queue }) => {
  await queue.enqueue(Ping)
  // @ts-expect-error Ping takes no payload
  await queue.enqueue(Ping, { x: 1 })
} })
import { defineTable, t, type Row } from '@bolide/data'
const notes = defineTable('notes', { id: t.uuid().primaryKey(), body: t.text().nullable() })
export const note: Row<typeof notes> = { id: '', body: null }
// @ts-expect-error body is a string or null
export const bad: Row<typeof notes> = { id: '', body: 1 }
import { createClient } from '@bolide/client'
import { defineMutator } from '@bolide/data'
type Id = { id: string }
const add = defineMutator({ name: 'notes.add', input: { '~standard': { version: 1, vendor: 'x', validate: (v: unknown) => ({ value: v as Id }), types: undefined as unknown as { input: Id; output: Id } } }, run: () => {} })
const client = createClient({ transport: { subscribe: () => () => {} }, mutators: [add] })
client.mutate(add, { id: 'x' })
// @ts-expect-error id is required
client.mutate(add, {})
TS
npm run typecheck --silent
rm src/types-check.ts
# Batteries must load from dist next to the installed core (one core instance, shared tokens).
node --input-type=module -e "
const { createApp, createLogger } = await import('@bolide/core')
const { Cache, cacheModule } = await import('@bolide/cache')
const app = await createApp({ modules: [cacheModule()], logger: createLogger({ level: 'error' }) })
if ((await app.get(Cache).wrap('k', () => 42)) !== 42) process.exit(1)
const { defineJob, Queue, queueModule } = await import('@bolide/queue')
let ran = 0
const Ping = defineJob({ name: 'ping', handler: () => void ran++ })
const q = await createApp({ modules: [queueModule({ jobs: [Ping] })], logger: createLogger({ level: 'error' }) })
await q.get(Queue).enqueue(Ping)
await q.get(Queue).idle()
await q.close()
if (ran !== 1) process.exit(1)
const { authModule, hashPassword, Sessions, verifyPassword } = await import('@bolide/auth')
if (!(await verifyPassword('pw', await hashPassword('pw', { cost: 1024 })))) process.exit(1)
await createApp({ modules: [authModule()], use: [Sessions], logger: createLogger({ level: 'error' }) })
const { Mailer, mailModule, memoryTransport } = await import('@bolide/mail')
const { SendMail } = await import('@bolide/mail/queue')
const transport = memoryTransport()
const mq = await createApp({ modules: [mailModule({ transport, from: 'a@b.co' }), queueModule({ jobs: [SendMail] })], logger: createLogger({ level: 'error' }) })
await mq.get(Queue).enqueue(SendMail, { to: 'c@d.co', subject: 's', text: 't' })
await mq.get(Queue).idle()
await mq.close()
if (transport.sent.length !== 1) process.exit(1)
const { defineTable, t } = await import('@bolide/data')
const { schemaSql } = await import('@bolide/data/server')
if (!schemaSql([defineTable('notes', { id: t.uuid().primaryKey() })]).includes('create table \"notes\"')) process.exit(1)
const { createClient } = await import('@bolide/client')
if (typeof createClient({ transport: { subscribe: () => () => {} }, mutators: [] }).mutate !== 'function') process.exit(1)
const { Storage, storageModule } = await import('@bolide/storage')
const st = await createApp({ modules: [storageModule()], logger: createLogger({ level: 'error' }) })
await st.get(Storage).put('a/b.txt', 'hi')
if ((await st.get(Storage).text('a/b.txt')) !== 'hi') process.exit(1)
"
npm test --silent

# The installed binary (from the tarball, not the repo) must serve the app.
./node_modules/.bin/bolide help >/dev/null
port=$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")
# Run the installed bin directly (not through npx, which may not pass SIGTERM on), so kill reaches it.
# Its own process group (set -m), so a failure can stop the watcher and the app with it.
set -m
./node_modules/.bin/bolide dev --port "$port" >dev.log 2>&1 &
dev=$!
set +m
ok=
for _ in $(seq 1 50); do
  if curl -sf --max-time 2 "http://localhost:$port/openapi.json" >/dev/null; then ok=1; break; fi
  sleep 0.2
done
kill -- -"$dev" 2>/dev/null || kill "$dev" 2>/dev/null || true
# Every process in the group (bolide, node --watch, the app) must exit; never wait forever.
for _ in $(seq 1 25); do kill -0 -- -"$dev" 2>/dev/null || break; sleep 0.2; done
if kill -0 -- -"$dev" 2>/dev/null; then
  echo "pack-check: bolide dev or its app did not exit on SIGTERM" >&2
  cat dev.log >&2
  kill -9 -- -"$dev" 2>/dev/null || kill -9 "$dev" 2>/dev/null || true
  exit 1
fi
if [ -z "$ok" ]; then
  echo "pack-check: bolide dev did not serve the app" >&2
  cat dev.log >&2
  exit 1
fi
echo "pack-check: OK (installed from tarballs: typecheck, tests and bolide dev pass)"

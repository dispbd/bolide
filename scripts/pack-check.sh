#!/usr/bin/env bash
# Packs @bolide/core and @bolide/cli, installs them into a project made by
# `bolide create` (as a user would, from tarballs), then typechecks and tests it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$root"
npm run build --silent
npm pack -w @bolide/core -w @bolide/cli --pack-destination "$work" --silent >/dev/null
node packages/cli/bin/bolide.mjs create "$work/app" >/dev/null
cd "$work/app"
node -e "
const fs = require('fs')
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tgz = (name) => 'file:../' + fs.readdirSync('..').find((f) => f.startsWith('bolide-' + name + '-'))
p.dependencies['@bolide/core'] = tgz('core')
p.devDependencies['@bolide/cli'] = tgz('cli')
fs.writeFileSync('package.json', JSON.stringify(p, null, 2))
"
npm install --silent
# Types from dist/*.d.ts must be real, not silently any.
cat > src/types-check.ts <<'TS'
import { defineService } from '@bolide/core'
const s = defineService({ name: 'x', factory: () => 1 })
// @ts-expect-error name is a string
export const n: number = s.name
TS
npm run typecheck --silent
rm src/types-check.ts
npm test --silent

# The installed binary (from the tarball, not the repo) must serve the app.
npx --no-install bolide help >/dev/null
port=$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")
npx --no-install bolide dev --port "$port" >dev.log 2>&1 &
dev=$!
ok=
for _ in $(seq 1 50); do
  if curl -sf "http://localhost:$port/openapi.json" >/dev/null; then ok=1; break; fi
  sleep 0.2
done
kill "$dev" 2>/dev/null || true
wait "$dev" 2>/dev/null || true
if [ -z "$ok" ]; then
  echo "pack-check: bolide dev did not serve the app" >&2
  cat dev.log >&2
  exit 1
fi
echo "pack-check: OK (installed from tarballs: typecheck, tests and bolide dev pass)"

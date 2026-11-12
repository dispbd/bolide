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
npm run typecheck --silent
npm test --silent
echo "pack-check: OK (installed from tarballs, typecheck and tests pass)"

#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
docker rm -f bolide-electric >/dev/null 2>&1
RUN_AS=(); [ "$(id -u)" = "0" ] && RUN_AS=(runuser -u postgres --)
"${RUN_AS[@]}" "${PGBIN:-/usr/lib/postgresql/16/bin}/pg_ctl" -D "$ROOT/.pgdata" stop >/dev/null
echo stopped

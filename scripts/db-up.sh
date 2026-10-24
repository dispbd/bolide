#!/usr/bin/env bash
# Local Postgres 16 (wal_level=logical) + Electric sync service in Docker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGDATA="$ROOT/.pgdata"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-54321}"
ELECTRIC_PORT="${ELECTRIC_PORT:-3000}"
RUN_AS=()
[ "$(id -u)" = "0" ] && RUN_AS=(runuser -u postgres --)

if [ ! -d "$PGDATA" ]; then
  mkdir -p "$PGDATA"; [ "$(id -u)" = "0" ] && chown postgres "$PGDATA"
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
  cat >> "$PGDATA/postgresql.conf" <<CONF
wal_level = logical
port = $PGPORT
listen_addresses = 'localhost'
unix_socket_directories = '/tmp'
CONF
fi
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1 \
  || "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start >/dev/null
psql -h localhost -p "$PGPORT" -U postgres -tc "select 1 from pg_database where datname='crucible'" | grep -q 1 \
  || psql -h localhost -p "$PGPORT" -U postgres -c "create database crucible" >/dev/null
psql -h localhost -p "$PGPORT" -U postgres -qc "alter user postgres password 'postgres'"
psql -h localhost -p "$PGPORT" -U postgres -d crucible -q -f "$ROOT/spike/server/schema.sql"

if ! docker ps --format '{{.Names}}' | grep -q '^crucible-electric$'; then
  docker rm -f crucible-electric >/dev/null 2>&1 || true
  docker run -d --name crucible-electric --network host \
    -e DATABASE_URL="postgresql://postgres:postgres@localhost:$PGPORT/crucible?sslmode=disable" \
    -e ELECTRIC_INSECURE=true -e ELECTRIC_PORT="$ELECTRIC_PORT" \
    electricsql/electric:latest >/dev/null
fi
for i in $(seq 1 60); do
  curl -sf "http://localhost:$ELECTRIC_PORT/v1/health" | grep -q active && { echo "postgres :$PGPORT, electric :$ELECTRIC_PORT ready"; exit 0; }
  sleep 1
done
echo "electric did not become ready"; docker logs --tail 30 crucible-electric; exit 1

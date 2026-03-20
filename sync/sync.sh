#!/bin/sh
# Sync PostgreSQL Debian → PostgreSQL Hostinger
# Source  : frps:15432 (tunnel frp vers postgres Debian)
# Destination : postgres_db (container existant sur Hostinger)

set -e

echo "=== SYNC START $(date) ==="

PGPASSWORD=$SRC_PASS pg_dump \
  -h "$SRC_HOST" -p "$SRC_PORT" \
  -U "$SRC_USER" -d "$SRC_DB" \
  --data-only --if-exists --clean \
  --no-acl --no-owner \
| PGPASSWORD=$DST_PASS psql \
  -h "$DST_HOST" -p "$DST_PORT" \
  -U "$DST_USER" -d "$DST_DB" \
  --set ON_ERROR_STOP=0

echo "=== SYNC DONE $(date) ==="

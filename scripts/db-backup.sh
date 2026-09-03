#!/usr/bin/env bash
# Logical backup of the Anchor Postgres database (operational runbook, docs/nexus/10 §X,
# CP control family). Writes a timestamped custom-format dump to ./backups/.
#
#   scripts/db-backup.sh                 # via the nexus-db docker container (default)
#   DB_CONTAINER= DATABASE_URL=postgres://nexus:nexus@host:5432/nexus scripts/db-backup.sh
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-nexus-db}"
DB_NAME="${DB_NAME:-nexus}"
DB_USER="${DB_USER:-nexus}"
OUT_DIR="${OUT_DIR:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/anchor-${DB_NAME}-${STAMP}.dump"

echo "Backing up '$DB_NAME' -> $OUT"
if [ -n "${DATABASE_URL:-}" ] && [ -z "${DB_CONTAINER:-}" ]; then
  # Direct pg_dump against a URL (requires pg_dump on PATH).
  pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$OUT"
else
  # Through the Docker Postgres container (no host pg client needed).
  docker exec -i "$DB_CONTAINER" pg_dump --format=custom --no-owner -U "$DB_USER" "$DB_NAME" > "$OUT"
fi

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "Done: $OUT (${SIZE} bytes)"
echo "Restore with: scripts/db-restore.sh $OUT"

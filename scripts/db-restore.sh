#!/usr/bin/env bash
# Restore an Anchor Postgres backup produced by db-backup.sh (DR drill, docs/nexus/10 §X).
# DESTRUCTIVE: drops and recreates objects in the target database.
#
#   scripts/db-restore.sh backups/anchor-nexus-20260612T...Z.dump
set -euo pipefail

DUMP="${1:-}"
[ -z "$DUMP" ] && { echo "usage: $0 <dump-file>"; exit 2; }
[ -f "$DUMP" ] || { echo "no such file: $DUMP"; exit 2; }

DB_CONTAINER="${DB_CONTAINER:-nexus-db}"
DB_NAME="${DB_NAME:-nexus}"
DB_USER="${DB_USER:-nexus}"

read -r -p "This will OVERWRITE database '$DB_NAME'. Continue? [y/N] " ans
[ "${ans:-N}" = "y" ] || { echo "aborted"; exit 1; }

echo "Restoring $DUMP -> '$DB_NAME'"
if [ -n "${DATABASE_URL:-}" ] && [ -z "${DB_CONTAINER:-}" ]; then
  pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP"
else
  docker exec -i "$DB_CONTAINER" pg_restore --clean --if-exists --no-owner -U "$DB_USER" -d "$DB_NAME" < "$DUMP"
fi
echo "Restore complete. Verify with: scripts/smoke.sh"

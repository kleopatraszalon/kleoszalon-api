#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

OUT="${BACKUP_FILE:-/tmp/kleoszalon-backup-$(date +%Y%m%d-%H%M%S).dump}"

echo "[backup-smoke] creating logical backup"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$OUT"

echo "[backup-smoke] validating archive structure"
pg_restore --list "$OUT" >/tmp/kleoszalon-backup-list.txt
if ! grep -q "TABLE" /tmp/kleoszalon-backup-list.txt; then
  echo "[backup-smoke] ERROR: archive contains no table entries" >&2
  exit 1
fi

if [[ -n "${RESTORE_TEST_DATABASE_URL:-}" ]]; then
  if [[ "$RESTORE_TEST_DATABASE_URL" == "$DATABASE_URL" ]]; then
    echo "[backup-smoke] ERROR: RESTORE_TEST_DATABASE_URL must never equal production DATABASE_URL" >&2
    exit 1
  fi
  echo "[backup-smoke] restoring into isolated test database"
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_TEST_DATABASE_URL" "$OUT"
  psql "$RESTORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null
  echo "[backup-smoke] isolated restore succeeded"
else
  echo "[backup-smoke] RESTORE_TEST_DATABASE_URL not set; archive validation completed without destructive restore"
fi

echo "[backup-smoke] OK: $OUT"

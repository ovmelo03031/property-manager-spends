#!/usr/bin/env bash
# Backup of the database and uploaded files. Usage: ./scripts/backup.sh [destination-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-./backups}"; mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
# Consistent SQLite snapshot even while the container is running (VACUUM INTO needs a fresh target).
docker compose exec -T gastos rm -f /data/gastos-backup.db
docker compose exec -T gastos bun -e "import { Database } from 'bun:sqlite'; new Database('/data/gastos.db').run(\"VACUUM INTO '/data/gastos-backup.db'\")"
tar -czf "$DEST/gastos-$STAMP.tar.gz" -C data gastos-backup.db blobs
rm -f data/gastos-backup.db
echo "Backup ready: $DEST/gastos-$STAMP.tar.gz"

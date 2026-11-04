#!/usr/bin/env bash
# Respaldo de la base de datos y los archivos. Uso: ./scripts/backup.sh [carpeta-destino]
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:-./backups}"; mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
# copia consistente de SQLite aunque el contenedor esté corriendo
docker compose exec -T gastos node -e "require('better-sqlite3')('/data/gastos.db').backup('/data/gastos-backup.db').then(()=>process.exit(0))"
tar -czf "$DEST/gastos-$STAMP.tar.gz" -C data gastos-backup.db blobs
rm -f data/gastos-backup.db
echo "Respaldo listo: $DEST/gastos-$STAMP.tar.gz"

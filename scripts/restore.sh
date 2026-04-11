#!/usr/bin/env bash
# restore.sh — Restaura un backup de PostgreSQL para labshorturl
#
# Uso:
#   ./scripts/restore.sh backups/labshorturl_20240101_030000.sql.gz
#
# ADVERTENCIA: Esto borrará todos los datos actuales de la base de datos.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +o allexport
fi

DATABASE_URL="${DATABASE_URL:-postgresql://labshorturl:labshorturl@localhost:5432/labshorturl}"
BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Uso: $0 <archivo-backup.sql.gz>"
  echo ""
  echo "Backups disponibles:"
  ls -lh "$PROJECT_DIR/backups/"labshorturl_*.sql.gz 2>/dev/null || echo "  (ninguno)"
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Error: archivo no encontrado: $BACKUP_FILE"
  exit 1
fi

echo "⚠️  ADVERTENCIA: Esto reemplazará TODOS los datos en la base de datos."
echo "   Base de datos: $DATABASE_URL"
echo "   Backup:        $BACKUP_FILE"
echo ""
read -r -p "¿Continuar? [s/N] " CONFIRM
if [[ "${CONFIRM,,}" != "s" ]]; then
  echo "Cancelado."
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restaurando desde $BACKUP_FILE …"

# Terminar conexiones activas y restaurar
psql "$DATABASE_URL" -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid();
" > /dev/null 2>&1 || true

gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL" --no-password -v ON_ERROR_STOP=1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restauración completada."

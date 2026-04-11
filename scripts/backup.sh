#!/usr/bin/env bash
# backup.sh — Copia de seguridad de PostgreSQL para labshorturl
#
# Uso:
#   ./scripts/backup.sh
#
# Variables de entorno (opcionales — toma defaults del .env si existe):
#   DATABASE_URL   postgresql://usuario:pass@host:5432/labshorturl
#   BACKUP_DIR     Directorio donde guardar los backups  (default: ./backups)
#   KEEP_DAYS      Días de retención                     (default: 30)
#
# Cron diario a las 03:00:
#   0 3 * * * /ruta/al/proyecto/scripts/backup.sh >> /ruta/al/proyecto/logs/backup.log 2>&1

set -euo pipefail

# ── Configuración ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Carga .env si existe (no sobreescribe variables ya definidas)
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +o allexport
fi

DATABASE_URL="${DATABASE_URL:-postgresql://labshorturl:labshorturl@localhost:5432/labshorturl}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/labshorturl_${TIMESTAMP}.sql.gz"

# ── Preparar directorio ───────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

# ── Ejecutar backup ───────────────────────────────────────────────────────────
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando backup → $BACKUP_FILE"

pg_dump "$DATABASE_URL" \
  --no-password \
  --format=plain \
  --no-owner \
  --no-privileges \
  | gzip -9 > "$BACKUP_FILE"

SIZE="$(du -sh "$BACKUP_FILE" | cut -f1)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup completado — $SIZE"

# ── Limpiar backups antiguos ──────────────────────────────────────────────────
DELETED="$(find "$BACKUP_DIR" -name 'labshorturl_*.sql.gz' -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
if [[ "$DELETED" -gt 0 ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Eliminados $DELETED backup(s) con más de ${KEEP_DAYS} días"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backups disponibles: $(find "$BACKUP_DIR" -name 'labshorturl_*.sql.gz' | wc -l)"

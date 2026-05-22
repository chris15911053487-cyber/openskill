#!/usr/bin/env bash
# OpenSkill backup script.
#
# Creates a timestamped backup of the SQLite database (online-safe, using
# `sqlite3 .backup`) and a tar.gz of the storage directory containing all
# uploaded skill ZIPs.
#
# Usage:
#   ./scripts/backup.sh [BACKUP_DIR]
#
# BACKUP_DIR defaults to ./backups
#
# Notes:
# - Safe to run while the server is up: the .backup pragma takes a consistent
#   snapshot using SQLite's online backup API.
# - Restore: stop the container, copy backup files into ./data/, restart.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${OPENSKILL_DATA_DIR:-$ROOT_DIR/data}"
BACKUP_DIR="${1:-$ROOT_DIR/backups}"
TS="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$DATA_DIR/openskill.db" ]]; then
  echo "ERROR: $DATA_DIR/openskill.db not found." >&2
  echo "Set OPENSKILL_DATA_DIR or pass the data directory as a second arg." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

DB_BACKUP="$BACKUP_DIR/openskill-$TS.db"
STORAGE_BACKUP="$BACKUP_DIR/storage-$TS.tar.gz"

if command -v sqlite3 >/dev/null 2>&1; then
  echo "Backing up SQLite -> $DB_BACKUP"
  sqlite3 "$DATA_DIR/openskill.db" ".backup '$DB_BACKUP'"
else
  echo "sqlite3 not installed, falling back to file copy (still safe with WAL mode)"
  cp "$DATA_DIR/openskill.db" "$DB_BACKUP"
fi

if [[ -d "$DATA_DIR/storage" ]]; then
  echo "Backing up storage -> $STORAGE_BACKUP"
  tar -czf "$STORAGE_BACKUP" -C "$DATA_DIR" storage
fi

echo
echo "✅ Backup complete:"
ls -lh "$DB_BACKUP" "$STORAGE_BACKUP" 2>/dev/null || true
echo
echo "To restore:"
echo "  1. docker compose -f docker-compose.deploy.yml down"
echo "  2. cp $DB_BACKUP $DATA_DIR/openskill.db"
echo "  3. tar -xzf $STORAGE_BACKUP -C $DATA_DIR"
echo "  4. docker compose -f docker-compose.deploy.yml up -d"

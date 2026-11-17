#!/usr/bin/env bash
set -euo pipefail

# Sauvegarde à chaud d'une instance Attroupe (base SQLite en mode WAL + dossier fichiers éventuel).
# Usage : sauvegarde.sh [dossier_donnees] [dossier_destination]

DATA_DIR="${1:-./data}"
DEST_DIR="${2:-./sauvegardes}"
BASE="$DATA_DIR/attroupe.sqlite"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Erreur : la commande sqlite3 est introuvable." >&2
  exit 1
fi

if [ ! -f "$BASE" ]; then
  echo "Erreur : base SQLite introuvable : $BASE" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TMP_DB="$TMP_DIR/attroupe.sqlite"
sqlite3 -cmd ".timeout 5000" "$BASE" "VACUUM INTO '$TMP_DB';"

if [ -d "$DATA_DIR/fichiers" ]; then
  cp -a "$DATA_DIR/fichiers" "$TMP_DIR/fichiers"
fi

HORODATAGE="$(date +%Y-%m-%d_%H%M%S)"
ARCHIVE="$DEST_DIR/attroupe-$HORODATAGE.tar.gz"
tar -czf "$ARCHIVE" -C "$TMP_DIR" .
chmod 600 "$ARCHIVE"

echo "$ARCHIVE"

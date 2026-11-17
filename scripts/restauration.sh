#!/usr/bin/env bash
set -euo pipefail

# Restauration d'une archive produite par sauvegarde.sh.
# Usage : restauration.sh <archive.tar.gz> [dossier_donnees] [--force]

ARCHIVE=""
DATA_DIR="./data"
DATA_DIR_DEFINI=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=1
      ;;
    -*)
      echo "Option inconnue : $arg" >&2
      exit 1
      ;;
    *)
      if [ -z "$ARCHIVE" ]; then
        ARCHIVE="$arg"
      elif [ "$DATA_DIR_DEFINI" -eq 0 ]; then
        DATA_DIR="$arg"
        DATA_DIR_DEFINI=1
      else
        echo "Argument inattendu : $arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "$ARCHIVE" ]; then
  echo "Usage : $0 <archive.tar.gz> [dossier_donnees] [--force]" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Erreur : la commande sqlite3 est introuvable." >&2
  exit 1
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "Erreur : archive introuvable : $ARCHIVE" >&2
  exit 1
fi

CIBLE_BASE="$DATA_DIR/attroupe.sqlite"
if [ -e "$CIBLE_BASE" ] && [ "$FORCE" -ne 1 ]; then
  echo "Erreur : une base existe déjà dans $DATA_DIR (ajoutez --force pour écraser)." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

tar -xzf "$ARCHIVE" -C "$TMP_DIR"

if [ ! -f "$TMP_DIR/attroupe.sqlite" ]; then
  echo "Erreur : l'archive ne contient pas attroupe.sqlite." >&2
  exit 1
fi

INTEGRITE="$(sqlite3 "$TMP_DIR/attroupe.sqlite" "PRAGMA integrity_check;")"
if [ "$INTEGRITE" != "ok" ]; then
  echo "Erreur : vérification d'intégrité SQLite échouée ($INTEGRITE)." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
rm -f "$CIBLE_BASE" "$CIBLE_BASE-wal" "$CIBLE_BASE-shm"
cp "$TMP_DIR/attroupe.sqlite" "$CIBLE_BASE"

if [ -d "$TMP_DIR/fichiers" ]; then
  rm -rf "$DATA_DIR/fichiers"
  cp -a "$TMP_DIR/fichiers" "$DATA_DIR/fichiers"
fi

echo "Restauration terminée dans $DATA_DIR"

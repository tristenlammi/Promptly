#!/usr/bin/env bash
# ============================================================
# Promptly — restore a full backup (Linux / macOS)
#
#   ./scripts/restore.sh <promptly-backup-*.tar> [--yes] [--with-env]
#   ./scripts/restore.sh --db-only <file.dump>   [--yes]
#
# Replaces this install's database (and, for a full archive, its files)
# with the backup's. The database is dropped and recreated — not merged —
# so nothing from the current state survives. Your current files are
# moved aside to <uploads>.before-restore-<time>, not deleted.
#
# --with-env  also restore the backup's .env (needed when restoring onto a
#             new machine: its SECRET_KEY decrypts the stored API keys).
#             Without it, .env is left alone and you're warned if the
#             backup was taken with a different SECRET_KEY.
# --db-only   restore just a database dump, e.g. one of the automatic
#             data/backups/pre-migrate-*.dump or nightly-*.dump files.
# ============================================================
set -euo pipefail
# Git Bash on Windows rewrites container paths like /app into C:/...; stop it.
export MSYS_NO_PATHCONV=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

SRC="" ; YES=false ; WITH_ENV=false ; DB_ONLY=false
for a in "$@"; do
  case "$a" in
    --yes) YES=true ;;
    --with-env) WITH_ENV=true ;;
    --db-only) DB_ONLY=true ;;
    -*) fail "Unknown option: $a" ;;
    *) SRC="$a" ;;
  esac
done
[[ -n "$SRC" && -f "$SRC" ]] || fail "Usage: ./scripts/restore.sh <backup.tar> [--yes] [--with-env]  |  --db-only <file.dump>"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if $DB_ONLY; then
  cp "$SRC" "$WORK/db.dump"
else
  tar -C "$WORK" -xf "$SRC" || fail "Couldn't read $SRC as a Promptly backup."
  [[ -f "$WORK/db.dump" && -f "$WORK/files.tar" ]] || fail "$SRC isn't a full Promptly backup (no db.dump/files.tar)."
  cat "$WORK/MANIFEST" 2>/dev/null || true
fi

if ! $DB_ONLY && ! $WITH_ENV && [[ -f "$WORK/env" && -f .env ]]; then
  if [[ "$(grep -E '^SECRET_KEY=' "$WORK/env")" != "$(grep -E '^SECRET_KEY=' .env)" ]]; then
    warn "This backup was taken with a different SECRET_KEY. Stored API keys and"
    warn "secrets in it won't decrypt with this .env. Re-run with --with-env to"
    warn "restore the backup's .env as well (your current one is kept as .env.before-restore)."
  fi
fi

if ! $YES; then
  echo
  warn "This REPLACES the current database$($DB_ONLY || echo ' and files') with the backup's."
  read -r -p "Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || fail "Cancelled."
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
say "1/5  Stopping the app (database stays up)"
docker compose stop backend arq-worker media-worker tusd collab >/dev/null
docker compose up -d postgres >/dev/null
for _ in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U promptly >/dev/null 2>&1 && break; sleep 2
done

say "2/5  Recreating the database"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U promptly -d postgres \
  -c "DROP DATABASE IF EXISTS promptly WITH (FORCE)" \
  -c "CREATE DATABASE promptly OWNER promptly" >/dev/null

say "3/5  Restoring the database"
docker compose exec -T postgres pg_restore --no-owner --exit-on-error -U promptly -d promptly < "$WORK/db.dump" \
  || fail "pg_restore failed — the database is incomplete. Fix the error and run this again."

if ! $DB_ONLY; then
  say "4/5  Restoring files"
  # Uploads go back where this install keeps them (PROMPTLY_UPLOADS_DIR,
  # WP-7.1), whiteboards to data/whiteboard.
  UPLOADS_DIR="${PROMPTLY_UPLOADS_DIR:-$(grep -E '^PROMPTLY_UPLOADS_DIR=' .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')}"
  UPLOADS_DIR="${UPLOADS_DIR:-data/uploads}"
  [[ -e "$UPLOADS_DIR" ]] && mv "$UPLOADS_DIR" "$UPLOADS_DIR.before-restore-$TS"
  [[ -e "data/whiteboard" ]] && mv "data/whiteboard" "data/whiteboard.before-restore-$TS"
  mkdir -p data "$WORK/files" "$(dirname "$UPLOADS_DIR")"
  tar -C "$WORK/files" -xf "$WORK/files.tar"
  mv "$WORK/files/uploads" "$UPLOADS_DIR"
  mv "$WORK/files/whiteboard" data/whiteboard
  if $WITH_ENV && [[ -f "$WORK/env" ]]; then
    [[ -f .env ]] && cp .env ".env.before-restore-$TS"
    cp "$WORK/env" .env && chmod 600 .env
  fi
else
  say "4/5  (database only — files left as they are)"
fi

say "5/5  Starting the app"
docker compose up -d >/dev/null
for _ in $(seq 1 90); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>/dev/null)" == "healthy" ]] && break
  printf '.'; sleep 2
done
echo
if [[ "$(docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>/dev/null)" == "healthy" ]]; then
  printf '\033[32m%s\033[0m\n' "Restore complete."
else
  warn "The backend isn't healthy yet — check: docker compose logs --tail=60 backend"
fi
$DB_ONLY || echo "Your previous files are in data/*.before-restore-$TS — delete them once you're happy."

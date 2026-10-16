#!/usr/bin/env bash
# ============================================================
# Promptly — full backup (Linux / macOS)
#
#   ./scripts/backup.sh [output-dir]      (default: ./data/backups/full)
#
# Writes one archive, promptly-backup-<time>.tar, holding everything a
# restore needs:
#
#   db.dump      pg_dump -Fc of the database (taken by the postgres
#                container itself, so the client always matches the server)
#   files.tar    data/uploads + data/whiteboard (your files)
#   env          a copy of .env — SECRET_KEY in it decrypts every stored
#                API key and secret; without it a restore can't use them
#   MANIFEST     version, git commit and schema revision
#
# Copying ./data while Postgres is running is NOT a backup (the files can
# be mid-write); this is. Restore with ./scripts/restore.sh <archive>.
#
# The archive contains your secrets: it's created readable by you only.
# Keep a copy somewhere other than this machine.
# ============================================================
set -euo pipefail
# Git Bash on Windows rewrites container paths like /app into C:/...; stop it.
export MSYS_NO_PATHCONV=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="${1:-$ROOT_DIR/data/backups/full}"
TS="$(date -u +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
umask 077

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# Where uploads live on this host: PROMPTLY_UPLOADS_DIR in .env (WP-7.1),
# else ./data/uploads.
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
UPLOADS_DIR="${PROMPTLY_UPLOADS_DIR:-$(env_value PROMPTLY_UPLOADS_DIR)}"
UPLOADS_DIR="${UPLOADS_DIR:-data/uploads}"

[[ -f .env ]] || fail "No .env here — run this from your Promptly install."
docker compose ps --status running --services 2>/dev/null | grep -qx postgres \
  || fail "The postgres container isn't running — start the stack first (docker compose up -d)."

say "1/4  Dumping the database"
docker compose exec -T postgres pg_dump -Fc --no-owner -U promptly promptly > "$WORK/db.dump" \
  || fail "pg_dump failed — nothing was written."
[[ -s "$WORK/db.dump" ]] || fail "The database dump is empty — nothing was written."

say "2/4  Packing files ($UPLOADS_DIR, data/whiteboard)"
# Through the backend container when it's up: it can read every file
# regardless of host permissions. Otherwise straight from the host.
# Thumbnails and other derived files, half-finished uploads and the
# scrubber's quarantine are left out — they're regenerable or not data.
EXCLUDES=(--exclude=uploads/.staging --exclude=uploads/derived --exclude=uploads/.quarantine --exclude=uploads/.tus --exclude=uploads/.imports)
if docker compose ps --status running --services | grep -qx backend; then
  docker compose exec -T backend tar -C /app "${EXCLUDES[@]}" -cf - uploads whiteboard > "$WORK/files.tar"
else
  mkdir -p "$WORK/stage"
  ln -s "$(cd "$UPLOADS_DIR" && pwd)" "$WORK/stage/uploads"
  ln -s "$ROOT_DIR/data/whiteboard" "$WORK/stage/whiteboard"
  tar -h -C "$WORK/stage" "${EXCLUDES[@]}" -cf "$WORK/files.tar" uploads whiteboard
fi

say "3/4  Copying .env and writing the manifest"
cp .env "$WORK/env"
REV="$(docker compose exec -T postgres psql -U promptly -d promptly -tAc 'select version_num from alembic_version' 2>/dev/null || true)"
{
  echo "created_utc=$TS"
  echo "version=$(cat VERSION 2>/dev/null || echo unknown)"
  echo "git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "schema_revision=${REV:-unknown}"
} > "$WORK/MANIFEST"

say "4/4  Writing the archive"
mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/promptly-backup-$TS.tar"
tar -C "$WORK" -cf "$ARCHIVE" MANIFEST db.dump files.tar env
chmod 600 "$ARCHIVE"

printf '\033[32m%s\033[0m\n' "Backup written: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "It contains your .env secrets. Copy it off this machine, and keep it private."

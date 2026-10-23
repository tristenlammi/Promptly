#!/usr/bin/env bash
# ============================================================
# Promptly — one-command update (Linux / macOS)
#
#   ./update.sh                    update to the latest release (vX.Y.Z tag)
#   ./update.sh --version v0.9.0   update (or move) to a specific release
#   ./update.sh --channel main     follow the main branch instead of releases
#   ./update.sh --rollback         undo the last update: restore the database
#                                  backed up before it and go back to that code
#
# What it does, in order:
#   1. refuses to run over local edits to tracked files (they'd be lost or
#      break the merge — put settings in .env / docker-compose.override.yml)
#   2. shows what's changing: versions, new database migrations
#   3. backs up the database (data/backups/pre-update-*.dump, with a copy of
#      .env) and stops if that fails — some migrations delete data
#   4. checks out the new code, refreshes base images, rebuilds, restarts
#   5. reloads nginx (its config is bind-mounted)
#   6. waits until the backend is healthy and the worker and collab server
#      are running without restarting; on failure, prints how to roll back
#
# COMPOSE_PROFILES from .env is honoured, so bundled SearXNG / Ollama stay in
# the managed set and --remove-orphans never removes them.
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }

CHANNEL="release" ; VERSION="" ; ROLLBACK=false ; ALLOW_DIRTY=false ; YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --rollback) ROLLBACK=true; shift ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    --yes) YES=true; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) red "Unknown option: $1 (see ./update.sh --help)"; exit 1 ;;
  esac
done
[[ "$CHANNEL" == "release" || "$CHANNEL" == "main" ]] || { red "--channel must be 'release' or 'main'"; exit 1; }

[[ -f .env ]] || { red "No .env found — run ./install.sh first."; exit 1; }
mkdir -p data/backups
STATE=data/.last-update

wait_for_db() {
  for _ in $(seq 1 30); do
    docker compose exec -T postgres pg_isready -U promptly >/dev/null 2>&1 && return 0; sleep 2
  done
  return 1
}

# Backend healthy, then worker + collab up and not crash-looping.
wait_healthy() {
  local healthy=false
  for _ in $(seq 1 150); do
    case "$(docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>/dev/null || echo)" in
      healthy) healthy=true; break ;;
      starting) printf '.' ;;
      *) printf 'x' ;;
    esac
    sleep 2
  done
  echo
  $healthy || { red "  The backend didn't become healthy. Recent logs:"; docker compose logs --tail=40 backend || true; return 1; }
  green "  backend healthy"
  local before after
  before="$(docker inspect -f '{{.RestartCount}}' Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab 2>/dev/null | tr '\n' ' ')"
  sleep 15
  after="$(docker inspect -f '{{.RestartCount}}' Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab 2>/dev/null | tr '\n' ' ')"
  for c in Promptly-ArqWorker Promptly-MediaWorker Promptly-Collab; do
    if [[ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" != "running" ]]; then
      red "  $c isn't running. Recent logs:"; docker logs --tail=30 "$c" || true; return 1
    fi
  done
  if [[ "$before" != "$after" ]]; then
    red "  A worker or the collab server is restarting repeatedly:"
    docker compose logs --tail=30 arq-worker media-worker collab || true
    return 1
  fi
  green "  workers and collab running"
}

reload_nginx() {
  # Recreated, not reloaded: nginx.conf is a single-file bind mount, and
  # git replaces the file on update — a running container keeps the old
  # one, so a reload (or nginx -t inside it) never saw the new config.
  docker compose up -d --force-recreate --no-deps nginx >/dev/null 2>&1 || true
  sleep 2
  if ! docker compose exec -T nginx nginx -t >/dev/null 2>&1; then
    red "  nginx didn't accept its config. Recent logs:"
    docker compose logs --tail=20 nginx || true
  fi
}

# ---------------------------------------------------------------- rollback
if $ROLLBACK; then
  [[ -f "$STATE" ]] || { red "Nothing to roll back: no record of a previous update ($STATE)."; exit 1; }
  # shellcheck disable=SC1090
  source "$STATE"
  [[ -f "$DUMP" ]] || { red "The pre-update backup $DUMP is missing — can't roll back."; exit 1; }
  bold "Rolling back to $PREV_REF ($PREV_SHA), restoring $DUMP"
  yellow "This replaces the database with its state before the update. Anything done since is lost."
  if ! $YES; then read -r -p "Type 'rollback' to continue: " a; [[ "$a" == "rollback" ]] || exit 1; fi
  docker compose stop backend arq-worker media-worker tusd collab >/dev/null
  wait_for_db || { red "Postgres isn't ready."; exit 1; }
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U promptly -d postgres \
    -c "DROP DATABASE IF EXISTS promptly WITH (FORCE)" -c "CREATE DATABASE promptly OWNER promptly" >/dev/null
  docker compose exec -T postgres pg_restore --no-owner --exit-on-error -U promptly -d promptly < "$DUMP"
  git checkout --quiet "$PREV_SHA"
  docker compose build
  docker compose up -d --remove-orphans
  reload_nginx
  wait_healthy && green "Rolled back to $PREV_REF." || exit 1
  rm -f "$STATE"
  exit 0
fi

# ------------------------------------------------------------------ update
bold "1/6  Checking for local changes"
if ! $ALLOW_DIRTY && ! git diff --quiet HEAD -- 2>/dev/null; then
  red "These tracked files have local edits, which an update would overwrite or fail on:"
  git diff --name-only HEAD -- 2>/dev/null | sed 's/^/    /' >&2
  red "Move your settings into .env or docker-compose.override.yml (both are kept"
  red "across updates), or undo the edits with: git checkout -- <file>"
  red "To update anyway (and keep resolving conflicts yourself): ./update.sh --allow-dirty"
  exit 1
fi

bold "2/6  Finding the update"
git fetch --quiet --tags origin
PREV_SHA="$(git rev-parse HEAD)"
PREV_REF="$(git describe --tags --always 2>/dev/null || echo "$PREV_SHA")"
if [[ -n "$VERSION" ]]; then
  TARGET="$VERSION"
elif [[ "$CHANNEL" == "release" ]]; then
  TARGET="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)"
  [[ -n "$TARGET" ]] || { red "No releases found — use --channel main."; exit 1; }
else
  TARGET="origin/main"
fi
TARGET_SHA="$(git rev-parse "$TARGET^{commit}")" || { red "Unknown version: $TARGET"; exit 1; }
if [[ "$TARGET_SHA" == "$PREV_SHA" ]]; then
  green "Already on $TARGET — rebuilding and restarting anyway."
else
  echo "  Updating $PREV_REF → $TARGET"
  NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$PREV_SHA" "$TARGET_SHA" -- backend/alembic/versions | sed 's#.*/##')"
  if [[ -n "$NEW_MIGRATIONS" ]]; then
    echo "  Database changes in this update:"
    echo "$NEW_MIGRATIONS" | sed 's/^/    /'
  fi
  echo "  What's new: CHANGELOG.md"
fi

bold "3/6  Backing up the database"
wait_for_db || { red "Postgres isn't running — start the stack (docker compose up -d) and try again."; exit 1; }
TS="$(date -u +%Y%m%d-%H%M%S)"
DUMP="data/backups/pre-update-$(git rev-parse --short "$PREV_SHA")-$TS.dump"
(umask 077; docker compose exec -T postgres pg_dump -Fc --no-owner -U promptly promptly > "$DUMP") \
  || { rm -f "$DUMP"; red "The backup failed, so nothing was changed. Fix the error above (often: disk full) and retry."; exit 1; }
[[ -s "$DUMP" ]] || { rm -f "$DUMP"; red "The backup is empty, so nothing was changed."; exit 1; }
(umask 077; cp .env "$DUMP.env")
# Keep the last 5 pre-update backups.
ls -1t data/backups/pre-update-*.dump 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old" "$old.env"; done
printf 'PREV_SHA=%q\nPREV_REF=%q\nDUMP=%q\n' "$PREV_SHA" "$PREV_REF" "$DUMP" > "$STATE"
green "  $DUMP"

bold "4/6  Applying the update"
if [[ "$TARGET" == "origin/main" ]]; then
  git checkout --quiet main && git merge --ff-only --quiet origin/main
else
  git checkout --quiet "$TARGET"
fi
# Refresh third-party images (nginx, postgres, redis…) and the base images
# ours build FROM, so security fixes in them actually arrive.
docker compose pull --ignore-buildable --quiet || yellow "  Couldn't pull some images; continuing with what's here."
docker compose build --pull
docker compose up -d --remove-orphans

bold "5/6  Reloading nginx config"
reload_nginx
# Your own server blocks need the media links too (WP-7.5).
for f in nginx/local/*.conf; do
  [[ -f "$f" ]] || continue
  if grep -q "server[[:space:]]*{" "$f" && ! grep -q "promptly/media.conf" "$f"; then
    yellow "  $f has a server block without:  include /etc/nginx/promptly/media.conf;"
    yellow "  Add it inside that server block, or photos, videos and downloads won't load there."
  fi
done

bold "6/6  Checking everything came back"
if ! wait_healthy; then
  red ""
  red "The update didn't come up cleanly. To go back to $PREV_REF and the database"
  red "as it was before the update:"
  red "    ./update.sh --rollback"
  exit 1
fi
docker image prune -f >/dev/null 2>&1 || true

echo
docker compose ps
echo
green "Updated to $TARGET. (Undo with ./update.sh --rollback)"

#!/usr/bin/env bash
# ============================================================
# Promptly — one-command update (Linux / macOS)
#
#   ./update.sh
#
# Pulls the latest code, rebuilds images, recreates changed
# services, reloads nginx, and waits for health. Safe to re-run.
#
# Why a script instead of a raw `docker compose up -d --build`:
#   * It honours COMPOSE_PROFILES from .env, so the bundled
#     SearXNG / Ollama containers stay in the managed set and
#     `--remove-orphans` never nukes them.
#   * nginx.conf is bind-mounted (the nginx image isn't rebuilt),
#     so a config change needs an explicit reload to take effect —
#     this does it for you.
#   * The backend/frontend/collab nginx upstreams now re-resolve
#     via Docker DNS at request time, so nginx no longer needs a
#     restart when those containers get new IPs on recreate.
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }

if [[ ! -f .env ]]; then
  red "No .env found — run ./install.sh first."
  exit 1
fi

bold "1/5  Pulling latest code"
git pull --ff-only

bold "2/5  Building images"
docker compose build

bold "3/5  Applying updates"
# --remove-orphans cleans up services deleted from the compose file. It's
# safe here: COMPOSE_PROFILES in .env keeps SearXNG/Ollama in the active set,
# so they aren't treated as orphans.
docker compose up -d --remove-orphans

bold "4/5  Reloading nginx config"
# The nginx container isn't rebuilt (stock image + bind-mounted config), so a
# config change only lands on reload. Fall back to a full restart if the
# reload can't run (e.g. nginx was just recreated).
if docker compose exec -T nginx nginx -t >/dev/null 2>&1; then
  docker compose exec -T nginx nginx -s reload >/dev/null 2>&1 || docker compose restart nginx
else
  docker compose restart nginx
fi

bold "5/5  Waiting for the backend to become healthy"
healthy=false
for _ in $(seq 1 90); do
  status=$(docker inspect -f '{{.State.Health.Status}}' Promptly-Backend 2>/dev/null || echo "")
  if [[ "$status" == "healthy" ]]; then healthy=true; green "  backend healthy"; break; fi
  printf '.'; sleep 2
done
echo

if ! $healthy; then
  red "  backend didn't become healthy — recent logs:"
  docker compose logs --tail=40 backend || true
  exit 1
fi

echo
docker compose ps
echo
green "Update complete."

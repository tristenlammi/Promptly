#!/usr/bin/env bash
# ============================================================
# Promptly â€” one-shot install (Linux / macOS)
#
# This is the *only* script you need to run. Everything else
# (admin account, public domain, model providers, push notifications)
# is configured through the first-run wizard in your browser after
# this completes.
#
# Usage (from the repo root):
#   ./install.sh              # full stack (chat, search, local Ollama)
#   ./install.sh --minimal    # core only â€” skips SearXNG and the
#                             # bundled Ollama container. Useful if
#                             # you've already got Ollama running on
#                             # the host and don't need built-in web
#                             # search.
#
# Re-running is safe â€” already-set values in .env are preserved
# untouched. Only placeholders that still say "change-me" get
# replaced.
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ---------- argument parsing ----------
MINIMAL=false
for arg in "$@"; do
  case "$arg" in
    --minimal) MINIMAL=true ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *)
      red "Unknown argument: $arg (try --help)"
      exit 1
      ;;
  esac
done

# ---------- 1. prerequisite checks ----------
bold "Checking prerequisites"
if ! command -v docker >/dev/null 2>&1; then
  red "docker is not installed. Install from https://docs.docker.com/engine/install/"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  red "docker compose v2 is not available. Update Docker Engine to a recent version."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  red "The Docker daemon isn't reachable. Start Docker Desktop / Docker Engine and try again."
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  red "openssl is required to generate secrets. Install with: apt-get install openssl"
  exit 1
fi
green "  Docker, docker compose v2 and openssl detected"

# ---------- 2. .env bootstrap ----------
if [[ ! -f .env ]]; then
  bold "Creating .env from .env.example"
  cp .env.example .env
fi

# Replace a placeholder line `KEY=change-me-...` (still showing the
# example value) with `KEY=<generated>`. Lines the operator already
# customised are left alone.
seed_secret() {
  local key="$1" value="$2"
  if grep -qE "^${key}=change-me" .env; then
    # `|` as the sed delimiter so random hex output never collides.
    sed -i.bak "s|^${key}=change-me.*|${key}=${value}|" .env
    rm -f .env.bak
    green "  ${key} generated"
  else
    yellow "  ${key} already set, leaving untouched"
  fi
}

bold "Seeding secrets"
seed_secret SECRET_KEY        "$(openssl rand -hex 32)"
seed_secret SEARXNG_SECRET    "$(openssl rand -hex 32)"
seed_secret POSTGRES_PASSWORD "$(openssl rand -hex 24)"

# ---------- 3. build + start ----------
bold "Building images (first run can take 3-5 minutes)"
docker compose build

bold "Starting the stack"
if $MINIMAL; then
  # Core services only â€” same nginx front-door, but no SearXNG and
  # no bundled Ollama. Web search and local Custom-Models embeddings
  # will be unavailable until the operator adds them later.
  yellow "  --minimal: skipping searxng and ollama"
  docker compose up -d nginx frontend backend collab postgres redis
else
  docker compose up -d
fi

# ---------- 4. wait for the backend to come up ----------
bold "Waiting for the backend to become healthy"
healthy=false
for i in $(seq 1 90); do
  status=$(docker compose ps --format json backend 2>/dev/null \
    | grep -oE '"Health":"[a-z]+"' | head -n1 | cut -d'"' -f4 || true)
  if [[ "$status" == "healthy" ]]; then
    healthy=true
    printf '\n'
    green "  backend is healthy"
    break
  fi
  if [[ "$status" == "unhealthy" ]]; then
    printf '\n'
    red "  backend reports unhealthy. Showing the last 40 lines of logs:"
    docker compose logs --tail=40 backend || true
    exit 1
  fi
  printf '.'
  sleep 2
done

if ! $healthy; then
  printf '\n'
  red "  backend never became healthy after 3 minutes."
  red "  Last 60 lines of backend logs:"
  docker compose logs --tail=60 backend || true
  red ""
  red "  Common fixes:"
  red "    * 'docker compose ps' to see which container is unhealthy."
  red "    * 'docker compose down -v && ./install.sh' for a clean wipe."
  exit 1
fi

# ---------- 5. final report ----------
http_port=$(grep -E '^NGINX_HTTP_PORT=' .env | cut -d= -f2- || echo "8087")
http_port=${http_port:-8087}

bold ""
bold "=========================================================="
green " Promptly is up. "
bold "=========================================================="
echo
echo "  Open in your browser:"
if [[ "$http_port" == "80" ]]; then
  echo "    http://localhost"
else
  echo "    http://localhost:${http_port}"
fi
echo
echo "  The first visit will launch the setup wizard:"
echo "    1. Create the bootstrap admin account."
echo "    2. (Optional) Set the public URL people will reach Promptly on."
echo "    3. (Optional) Pick how knowledge libraries get embedded."
echo
echo "  Useful commands:"
echo "    docker compose logs -f backend     # tail backend logs"
echo "    docker compose ps                  # container health"
echo "    docker compose down                # stop everything"
echo

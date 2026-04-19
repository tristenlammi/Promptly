#!/usr/bin/env bash
# ============================================================
# Promptly — one-shot install
#
# Bootstraps a fresh server:
#   1. Verifies prerequisites (docker + docker compose v2).
#   2. Creates .env from .env.example if it doesn't exist.
#   3. Generates SECRET_KEY, SEARXNG_SECRET, POSTGRES_PASSWORD
#      with cryptographically strong randomness.
#   4. Optionally sets DOMAIN if passed as the first argument.
#   5. Builds and starts the full stack.
#
# Usage (from the repo root):
#   ./scripts/setup.sh                    # local install (DOMAIN=localhost)
#   ./scripts/setup.sh chat.example.com   # production install
#
# Re-running is safe — already-set values in .env are preserved
# untouched. Only placeholders that still say "change-me" get
# replaced.
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ---------- 1. prerequisite checks ----------
if ! command -v docker >/dev/null 2>&1; then
  red "docker is not installed. Install from https://docs.docker.com/engine/install/"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  red "docker compose v2 is not available. Update Docker Engine to a recent version."
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  red "openssl is required to generate secrets. Install with: apt-get install openssl"
  exit 1
fi

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
    # Use a sentinel char unlikely to appear in random hex output.
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

# ---------- 3. domain ----------
if [[ "${1:-}" != "" ]]; then
  bold "Setting DOMAIN to $1"
  if grep -qE '^DOMAIN=' .env; then
    sed -i.bak "s|^DOMAIN=.*|DOMAIN=$1|" .env
    rm -f .env.bak
  else
    printf 'DOMAIN=%s\n' "$1" >> .env
  fi
fi

# ---------- 4. build + start ----------
bold "Building images (first run can take 3-5 minutes)"
docker compose build

bold "Starting the stack"
docker compose up -d

# ---------- 5. wait for the backend to come up ----------
bold "Waiting for the backend to become healthy"
for i in $(seq 1 60); do
  status=$(docker compose ps --format json backend 2>/dev/null | grep -oE '"Health":"[a-z]+"' | head -n1 | cut -d'"' -f4 || true)
  if [[ "$status" == "healthy" ]]; then
    green "  backend is healthy"
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'

# ---------- 6. final report ----------
domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
http_port=$(grep -E '^NGINX_HTTP_PORT=' .env | cut -d= -f2- || echo "80")
http_port=${http_port:-80}

bold ""
bold "=========================================================="
green " Promptly is up. "
bold "=========================================================="
echo
echo "  Open in your browser:"
if [[ "$domain" == "localhost" || "$domain" == "" ]]; then
  if [[ "$http_port" == "80" ]]; then
    echo "    http://localhost"
  else
    echo "    http://localhost:${http_port}"
  fi
else
  echo "    http://${domain}"
  echo
  echo "  (Front it with Cloudflare Tunnel, Caddy, or a TLS-terminating"
  echo "   reverse proxy for HTTPS — see README.md > 'TLS termination'.)"
fi
echo
echo "  The first visit will launch the setup wizard to create"
echo "  the bootstrap admin account."
echo
echo "  Useful commands:"
echo "    docker compose logs -f backend     # tail backend logs"
echo "    docker compose ps                  # container health"
echo "    docker compose down                # stop everything"
echo

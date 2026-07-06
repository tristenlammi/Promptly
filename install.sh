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
#   ./install.sh              # full stack (chat, web search, local Ollama)
#   ./install.sh --no-ollama  # skip the bundled Ollama container - for
#                             # hosts that already run Ollama (set
#                             # OLLAMA_URL in .env to point at it), or
#                             # that don't want local models at all.
#   ./install.sh --no-search  # skip the bundled SearXNG container -
#                             # web search stays off until you add
#                             # Brave/Tavily keys in the admin panel.
#   ./install.sh --minimal    # both of the above.
#
# The choice persists: it's written to COMPOSE_PROFILES in .env, so a
# plain `docker compose up -d` keeps honouring it. Re-run with a flag
# to change your mind later.
#
# Re-running is safe - already-set values in .env are preserved
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
NO_OLLAMA=false
NO_SEARCH=false
PROFILE_FLAGS_GIVEN=false
for arg in "$@"; do
  case "$arg" in
    --no-ollama) NO_OLLAMA=true;  PROFILE_FLAGS_GIVEN=true ;;
    --no-search) NO_SEARCH=true;  PROFILE_FLAGS_GIVEN=true ;;
    --minimal)   NO_OLLAMA=true;  NO_SEARCH=true; PROFILE_FLAGS_GIVEN=true ;;
    -h|--help)
      sed -n '2,27p' "$0" | sed 's/^# //; s/^#//'
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
# The compose file uses optional depends_on (``required: false``), which
# needs compose >= 2.20 (mid-2023). Fail early with a clear message
# instead of a cryptic error at `up` time.
compose_ver=$(docker compose version --short 2>/dev/null | sed 's/^v//')
if [[ -n "$compose_ver" ]] && ! printf '2.20.0\n%s\n' "$compose_ver" | sort -V -C; then
  red "docker compose ${compose_ver} is too old (need >= 2.20). Update Docker Engine / Compose."
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

# ---------- 3. optional services (compose profiles) ----------
# COMPOSE_PROFILES in .env is the persistent source of truth: docker
# compose reads it on every invocation, so a plain `docker compose up -d`
# keeps honouring the install-time choice. Managed tokens: ollama, search.
# An operator-added "gpu" token is always preserved.
set_env_line() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# ---------- Ollama hardware auto-detection ----------
# Picks the best Ollama variant for this machine so acceleration works
# out of the box. Overridable any time by editing COMPOSE_PROFILES in
# .env (tokens: ollama = CPU, gpu = NVIDIA CUDA, rocm = AMD).
#   gpu    NVIDIA GPU + Docker GPU support
#   rocm   AMD GPU (/dev/kfd via the amdgpu driver)
#   host   macOS: Docker has no Metal passthrough, so if a native
#          Ollama is on the host we point the stack at it instead
#   ollama CPU container (universal fallback; Intel GPUs land here —
#          upstream Ollama has no Intel acceleration yet)
OLLAMA_VARIANT="ollama"
OLLAMA_VARIANT_LABEL="CPU (universal fallback)"
OLLAMA_VARIANT_NOTE=""
detect_ollama_variant() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if command -v ollama >/dev/null 2>&1 \
       || curl -fsS --max-time 1 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
      OLLAMA_VARIANT="host"
      OLLAMA_VARIANT_LABEL="native host Ollama (Metal acceleration)"
    else
      OLLAMA_VARIANT="ollama"
      OLLAMA_VARIANT_LABEL="CPU container"
      OLLAMA_VARIANT_NOTE="macOS: Docker can't reach the GPU. For Metal acceleration: 'brew install ollama', start it, re-run ./install.sh"
    fi
    return
  fi
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    # Docker must be able to hand the GPU to containers: the NVIDIA
    # Container Toolkit on Linux, or Docker Desktop's WSL2 backend.
    if docker info 2>/dev/null | grep -qi nvidia || uname -r | grep -qi microsoft; then
      OLLAMA_VARIANT="gpu"
      OLLAMA_VARIANT_LABEL="NVIDIA GPU (CUDA)"
    else
      OLLAMA_VARIANT_NOTE="NVIDIA GPU found, but Docker can't use it - install the NVIDIA Container Toolkit and re-run ./install.sh for GPU acceleration"
    fi
    return
  fi
  if [[ -e /dev/kfd && -e /dev/dri ]]; then
    OLLAMA_VARIANT="rocm"
    OLLAMA_VARIANT_LABEL="AMD GPU (ROCm)"
  fi
}

profiles=()
if ! $NO_OLLAMA; then
  detect_ollama_variant
  if [[ "$OLLAMA_VARIANT" != "host" ]]; then
    profiles+=("$OLLAMA_VARIANT")
  fi
fi
$NO_SEARCH || profiles+=("search")
profiles_csv=$(IFS=,; printf '%s' "${profiles[*]-}")

if $PROFILE_FLAGS_GIVEN || ! grep -qE '^COMPOSE_PROFILES=' .env; then
  bold "Configuring optional services"
  set_env_line COMPOSE_PROFILES "$profiles_csv"
  # The backend health probe + search provisioning key off this flag.
  set_env_line SEARXNG_ENABLED "$($NO_SEARCH && echo false || echo true)"
  if ! $NO_OLLAMA; then
    green "  Ollama: ${OLLAMA_VARIANT_LABEL}"
    [[ -n "$OLLAMA_VARIANT_NOTE" ]] && yellow "  ${OLLAMA_VARIANT_NOTE}"
    if [[ "$OLLAMA_VARIANT" == "host" ]]; then
      # Point the backend at the host's native Ollama. Respect an
      # operator-set URL; only seed when the line is missing.
      grep -qE '^OLLAMA_URL=' .env \
        || printf 'OLLAMA_URL=http://host.docker.internal:11434\n' >> .env
    fi
  fi
  $NO_OLLAMA && yellow "  --no-ollama: bundled Ollama disabled (set OLLAMA_URL in .env to use a host install)"
  $NO_SEARCH && yellow "  --no-search: bundled SearXNG disabled (add Brave/Tavily keys in the admin panel for web search)"
  green "  COMPOSE_PROFILES=${profiles_csv}"
else
  yellow "  COMPOSE_PROFILES already set, leaving untouched (re-run with --no-ollama/--no-search/--minimal to change)"
fi

# ---------- 4. build + start ----------
bold "Building images (first run can take 3-5 minutes)"
docker compose build

bold "Starting the stack"
docker compose up -d

# ---------- 5. wait for the backend to come up ----------
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

# ---------- 6. final report ----------
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
echo "    4. (Optional) Protect the admin account with two-step verification."
if $NO_OLLAMA; then
  echo
  yellow "  Note: bundled Ollama is disabled. For local models/embeddings,"
  yellow "  set OLLAMA_URL in .env (e.g. http://host.docker.internal:11434)"
  yellow "  or re-run ./install.sh without --no-ollama / --minimal."
fi
if $NO_SEARCH; then
  echo
  yellow "  Note: bundled web search (SearXNG) is disabled. Add a Brave or"
  yellow "  Tavily API key under Admin -> Settings to enable web search."
fi
echo
echo "  Useful commands:"
echo "    docker compose logs -f backend     # tail backend logs"
echo "    docker compose ps                  # container health"
echo "    docker compose down                # stop everything"
echo

#!/usr/bin/env bash
# ============================================================
# Promptly â€” one-shot install (Linux / macOS)
#
# This is the *only* script you need to run. Everything else
# (admin account, public domain, model providers, push notifications)
# is configured through the first-run wizard in your browser after
# this completes.
#
# Fresh machine, one line (needs git and Docker; downloads the latest release
# into ./Promptly and installs it):
#   curl -fsSL https://raw.githubusercontent.com/tristenlammi/Promptly/main/install.sh | bash
#   curl -fsSL ... | bash -s -- --no-maps      # the same, with options
#
# Usage (from the repo root):
#   ./install.sh                # cloud-first: bring your API keys (set in
#                               # the setup wizard). Auto-detects and uses a
#                               # native Ollama if one runs on the host.
#   ./install.sh --with-ollama  # also bundle an Ollama container for local
#                               # models - GPU auto-detected (NVIDIA/AMD),
#                               # else CPU. A native host Ollama is usually
#                               # faster; this is for hosts without one.
#   ./install.sh --no-search    # skip the bundled SearXNG container - web
#                               # search stays off until you add Brave/Tavily
#                               # keys in the admin panel.
#   ./install.sh --no-maps      # skip P Maps. It's on by default, and builds
#                               # its map data in the background: about an hour
#                               # and 15 GB of disk (7 GB after).
#   ./install.sh --no-calls     # skip the calls server (LiveKit) behind voice
#                               # channels in Rooms. On by default; voice stays
#                               # off for people until an admin turns it on.
#   ./install.sh --no-home      # skip Promptly Home's bundled Home Assistant
#                               # (smart devices; about 3.5 GB of disk).
#   ./install.sh --no-start     # set the folder up (.env, secrets, choices) but
#                               # don't build or start anything yet.
#
# One-line install only: PROMPTLY_DIR (where to put it; default ./Promptly),
# PROMPTLY_REF (a release tag or branch; default the latest release) and
# PROMPTLY_REPO (where to download from).
#
# The choice persists in COMPOSE_PROFILES in .env, so a plain
# `docker compose up -d` keeps honouring it. Re-run with a flag to change it.
#
# Re-running is safe - already-set values in .env are preserved
# untouched. Only placeholders that still say "change-me" get replaced.
# ============================================================
if [ -z "${BASH_VERSION:-}" ]; then
  echo "This installer needs bash. Run it with:  bash install.sh   (or pipe it to 'bash', not 'sh')" >&2
  exit 1
fi
set -euo pipefail

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# "sudo " in the commands we suggest, unless this already is root.
SUDO="sudo "
[[ "$(id -u)" == "0" ]] && SUDO=""

# How to get a missing program on this machine, as one line to paste.
how_to_install() {
  local pkg="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ "$pkg" == "git" ]]; then echo "xcode-select --install"; else echo "brew install $pkg"; fi
  elif command -v apt-get >/dev/null 2>&1; then echo "${SUDO}apt-get update && ${SUDO}apt-get install -y $pkg"
  elif command -v dnf >/dev/null 2>&1;     then echo "${SUDO}dnf install -y $pkg"
  elif command -v yum >/dev/null 2>&1;     then echo "${SUDO}yum install -y $pkg"
  elif command -v pacman >/dev/null 2>&1;  then echo "${SUDO}pacman -S --noconfirm $pkg"
  elif command -v zypper >/dev/null 2>&1;  then echo "${SUDO}zypper install -y $pkg"
  elif command -v apk >/dev/null 2>&1;     then echo "${SUDO}apk add $pkg"
  else echo "install '$pkg' with your system's package manager"
  fi
}

# Docker: installed, new enough, running, and usable by this user. Says what
# to do about whichever of those is wrong, then stops.
check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    red "Docker isn't installed. Promptly runs in Docker, so get that first:"
    if [[ "$(uname -s)" == "Linux" ]]; then
      red "    curl -fsSL https://get.docker.com | ${SUDO}sh"
      [[ -n "$SUDO" ]] && red "    sudo usermod -aG docker $(id -un)     # then log out and back in"
      red "  (that is Docker's own installer; other ways: https://docs.docker.com/engine/install/)"
    else
      red "    Docker Desktop: https://www.docker.com/products/docker-desktop/"
      red "  Install it, start it, and wait until it says it's running."
    fi
    red "Then run this installer again."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    red "This Docker has no 'docker compose' (version 2). Update Docker:"
    red "    https://docs.docker.com/engine/install/"
    exit 1
  fi
  # The compose file uses optional depends_on and env_file entries
  # (``required: false``), which need compose >= 2.24 (early 2024). Fail
  # early with a clear message instead of a cryptic error at `up` time.
  local compose_ver
  compose_ver=$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)
  if [[ -n "$compose_ver" ]] && ! printf '2.24.0\n%s\n' "$compose_ver" | sort -V -C 2>/dev/null; then
    red "docker compose ${compose_ver} is too old (Promptly needs 2.24 or newer). Update Docker:"
    red "    https://docs.docker.com/engine/install/"
    exit 1
  fi
  local err
  if ! err="$(docker info 2>&1 >/dev/null)"; then
    if [[ "$err" == *"ermission denied"* ]]; then
      red "Docker is installed, but your user ($(id -un)) isn't allowed to use it yet. Either:"
      red "    sudo usermod -aG docker $(id -un)     # then log out and back in, and run this again"
      red "  or run this installer with sudo."
    elif [[ "$(uname -s)" == "Linux" ]]; then
      red "Docker is installed but isn't running. Start it and run this again:"
      red "    ${SUDO}systemctl enable --now docker"
    else
      red "Docker is installed but isn't running. Start Docker Desktop, wait until it"
      red "says it's running, and run this again."
    fi
    exit 1
  fi
}

# ---------- 0. one-line install ----------
# Piped from the web (curl ... | bash), or run as a lone downloaded file:
# there is no Promptly folder around this script yet. Fetch the latest
# release into ./Promptly and carry on with the install.sh in there.
bootstrap() {
  local repo="${PROMPTLY_REPO:-https://github.com/tristenlammi/Promptly.git}"
  local ref="${PROMPTLY_REF:-}"
  local dir="${PROMPTLY_DIR:-$PWD/Promptly}"

  bold "Promptly installer"
  if [[ -f "$dir/install.sh" && -f "$dir/docker-compose.yml" ]]; then
    yellow "  $dir is already there, so the install carries on in it."
    yellow "  (To move an install to the newest version: cd \"$dir\" && ./update.sh)"
  else
    if [[ -e "$dir" ]] && [[ ! -d "$dir" || -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
      red "$dir already exists and isn't a Promptly folder."
      red "Move it away, or choose another place by putting PROMPTLY_DIR=/some/where before 'bash'."
      exit 1
    fi
    if ! command -v git >/dev/null 2>&1; then
      red "git isn't installed. It downloads Promptly now and updates it later. Get it with:"
      red "    $(how_to_install git)"
      command -v docker >/dev/null 2>&1 || red "Docker is missing too: https://docs.docker.com/engine/install/"
      red "Then run this installer again."
      exit 1
    fi
    check_docker
    if [[ -z "$ref" ]]; then
      # Newest vX.Y.Z tag. No tags (a fork, a mirror): the default branch.
      ref="$(git ls-remote --tags --refs "$repo" 'v[0-9]*' 2>/dev/null \
        | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
    fi
    echo "  Downloading Promptly ${ref:-(newest)} into $dir"
    local branch_args=()
    [[ -n "$ref" ]] && branch_args=(--branch "$ref")
    if ! git -c advice.detachedHead=false clone ${branch_args[@]+"${branch_args[@]}"} "$repo" "$dir"; then
      red "The download didn't work (git's message is above). Check the internet connection"
      red "and that this folder can be written to, then try again."
      exit 1
    fi
    green "  Downloaded"
  fi
  # Piped in: let the download of this script finish before handing over.
  if [[ -z "$SELF" && ! -t 0 ]]; then cat >/dev/null 2>&1 || true; fi
  cd "$dir"
  exec bash ./install.sh "$@" </dev/null
}

SELF="${BASH_SOURCE[0]:-}"
ROOT_DIR=""
if [[ -n "$SELF" && -f "$SELF" ]]; then
  ROOT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
fi
if [[ -z "$ROOT_DIR" || ! -f "$ROOT_DIR/docker-compose.yml" || ! -f "$ROOT_DIR/.env.example" ]]; then
  bootstrap "$@"
  exit 1
fi
cd "$ROOT_DIR"

# ---------- argument parsing ----------
WITH_OLLAMA=false
NO_SEARCH=false
NO_MAPS=false
NO_CALLS=false
NO_HOME=false
NO_START=false
PROFILE_FLAGS_GIVEN=false
for arg in "$@"; do
  case "$arg" in
    --with-ollama) WITH_OLLAMA=true; PROFILE_FLAGS_GIVEN=true ;;
    --no-search)   NO_SEARCH=true;   PROFILE_FLAGS_GIVEN=true ;;
    --no-maps)     NO_MAPS=true;     PROFILE_FLAGS_GIVEN=true ;;
    --no-calls)    NO_CALLS=true;    PROFILE_FLAGS_GIVEN=true ;;
    --no-home)     NO_HOME=true;     PROFILE_FLAGS_GIVEN=true ;;
    # Back-compat: --no-ollama is now the default; accept it silently.
    --no-ollama)   PROFILE_FLAGS_GIVEN=true ;;
    --no-start)    NO_START=true ;;
    -h|--help)
      sed -n '/^# Usage/,/^# ====/p' "$0" | sed '$d' | sed 's/^# //; s/^#//'
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
check_docker
if [[ ! -w . ]]; then
  red "This folder ($ROOT_DIR) can't be written to by $(id -un)."
  red "It belongs to $(stat -c %U . 2>/dev/null || stat -f %Su . 2>/dev/null || echo someone else): run the installer as that user, or with sudo."
  exit 1
fi
green "  Docker and docker compose are ready"

# Random hex for secrets: openssl when it's there, the kernel's generator when not.
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' 
'
  fi
}

# Room to work in. Not a hard stop: a warning the person can act on.
free_gb=$(df -Pk . 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}' || true)
need_gb=20
if [[ -n "${free_gb:-}" ]] && (( free_gb < need_gb )); then
  yellow "  Only ${free_gb} GB of disk is free here. The install needs about ${need_gb} GB"
  yellow "  (more with P Maps); it may stop part-way with \"no space left on device\"."
fi
mem_gb=""
if [[ -r /proc/meminfo ]]; then
  mem_gb=$(awk '/^MemTotal:/ {printf "%d", ($2+524288)/1048576}' /proc/meminfo 2>/dev/null || true)
elif [[ "$(uname -s)" == "Darwin" ]]; then
  mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
fi
if [[ -n "${mem_gb:-}" ]] && (( mem_gb > 0 && mem_gb < 4 )); then
  yellow "  This machine has about ${mem_gb} GB of memory. Promptly wants 4 GB or more;"
  yellow "  with less it can be slow or run out while building."
fi

# ---------- 2. .env bootstrap ----------
# A brand-new .env copies COMPOSE_PROFILES from the example, so "the line
# is missing" can't be how a first install is recognised.
FRESH_ENV=false
if [[ ! -f .env ]]; then
  FRESH_ENV=true
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
seed_secret SECRET_KEY        "$(rand_hex 32)"
seed_secret SEARXNG_SECRET    "$(rand_hex 32)"
seed_secret POSTGRES_PASSWORD "$(rand_hex 24)"
seed_secret SETUP_TOKEN       "$(rand_hex 6)"
# An .env from before this existed has no such line: add it.
for k in TUS_HOOK_SECRET; do
  grep -qE "^${k}=." .env || { sed -i.bak "/^${k}=\$/d" .env; rm -f .env.bak; printf '%s=change-me\n' "$k" >> .env; }
done
seed_secret TUS_HOOK_SECRET   "$(rand_hex 32)"
# Promptly Home: what its bundled home box proves itself with. Not made with
# --no-home, so a later update still offers it.
if ! $NO_HOME; then
  grep -qE "^HOME_BOX_SECRET=." .env || { sed -i.bak "/^HOME_BOX_SECRET=\$/d" .env; rm -f .env.bak; printf 'HOME_BOX_SECRET=change-me\n' >> .env; }
  seed_secret HOME_BOX_SECRET "$(rand_hex 32)"
fi
# Calls (LiveKit). An .env from before Calls has no such lines: add them.
for k in LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
  grep -qE "^${k}=" .env || printf '%s=change-me\n' "$k" >> .env
done
seed_secret LIVEKIT_API_KEY    "API$(rand_hex 8)"
seed_secret LIVEKIT_API_SECRET "$(rand_hex 32)"

# This machine's LAN address (for LIVEKIT_NODE_IP on Docker Desktop), or "".
lan_ip() {
  local ip=""
  if [[ "$(uname -s)" == "Darwin" ]]; then
    ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  else
    ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  fi
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s' "$ip"
  return 0
}

# ---------- 3. optional services (compose profiles) ----------
# COMPOSE_PROFILES in .env is the persistent source of truth: docker
# compose reads it on every invocation, so a plain `docker compose up -d`
# keeps honouring the install-time choice. Managed tokens: ollama/gpu/rocm
# (only with --with-ollama), search and maps.
set_env_line() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# ---------- Ollama mode ----------
# By default Promptly does NOT bundle an Ollama container: containerised
# Ollama has worse GPU support than a native install on every platform,
# and most self-hosters bring cloud API keys. Instead we auto-detect a
# native Ollama on the host and point the stack at it. --with-ollama
# bundles the container anyway, choosing the best variant for the box.
#   cloud    no Ollama; connect providers in the wizard (default)
#   host     a native Ollama is running on the host -> wire OLLAMA_URL
#   bundled  --with-ollama: run a container (gpu/rocm/ollama[cpu])
OLLAMA_MODE="cloud"
OLLAMA_LABEL="cloud providers only (connect your API keys in the wizard)"
OLLAMA_NOTE=""
OLLAMA_PROFILE=""

host_ollama_present() {
  command -v ollama >/dev/null 2>&1 \
    || curl -fsS --max-time 1 http://127.0.0.1:11434/api/version >/dev/null 2>&1
}

# Best bundled-container variant (only consulted with --with-ollama).
detect_bundled_variant() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 \
     && { docker info 2>/dev/null | grep -qi nvidia || uname -r | grep -qi microsoft; }; then
    OLLAMA_PROFILE="gpu";  OLLAMA_LABEL="bundled container - NVIDIA GPU (CUDA)"
  elif [[ -e /dev/kfd && -e /dev/dri ]]; then
    OLLAMA_PROFILE="rocm"; OLLAMA_LABEL="bundled container - AMD GPU (ROCm)"
  else
    OLLAMA_PROFILE="ollama"; OLLAMA_LABEL="bundled container - CPU"
    if command -v nvidia-smi >/dev/null 2>&1; then
      OLLAMA_NOTE="NVIDIA GPU found but Docker can't use it - install the NVIDIA Container Toolkit for acceleration."
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      OLLAMA_NOTE="macOS: the bundled container is CPU-only (no Metal in Docker). Install Ollama natively and re-run WITHOUT --with-ollama for acceleration."
    fi
  fi
}

if $WITH_OLLAMA; then
  OLLAMA_MODE="bundled"
  detect_bundled_variant
elif host_ollama_present; then
  OLLAMA_MODE="host"
  OLLAMA_LABEL="native host Ollama (detected on :11434)"
else
  OLLAMA_NOTE="Want local models? Install Ollama natively (https://ollama.com) and re-run, or use --with-ollama to bundle it."
fi

profiles=()
[[ "$OLLAMA_MODE" == "bundled" ]] && profiles+=("$OLLAMA_PROFILE")
$NO_SEARCH || profiles+=("search")
$NO_MAPS || profiles+=("maps")
# Calls: host networking on Linux; Docker Desktop has none, so it gets the
# bridged variant with the media ports published and this machine's LAN
# address advertised (docker-compose.yml, "Calls").
DOCKER_DESKTOP=false
docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop' && DOCKER_DESKTOP=true
if ! $NO_CALLS; then
  if $DOCKER_DESKTOP; then profiles+=("calls-desktop"); else profiles+=("calls"); fi
fi
# Promptly Home: on the host's network on Linux (devices are found by
# broadcast); bridged on Docker Desktop (docker-compose.yml, "Promptly Home").
if ! $NO_HOME; then
  if $DOCKER_DESKTOP; then profiles+=("home-desktop"); else profiles+=("home"); fi
fi
profiles_csv=$(IFS=,; printf '%s' "${profiles[*]-}")

if $PROFILE_FLAGS_GIVEN || $FRESH_ENV || ! grep -qE '^COMPOSE_PROFILES=' .env; then
  bold "Configuring optional services"
  set_env_line COMPOSE_PROFILES "$profiles_csv"
  # The backend health probe + search provisioning key off this flag.
  set_env_line SEARXNG_ENABLED "$($NO_SEARCH && echo false || echo true)"
  green "  Ollama: ${OLLAMA_LABEL}"
  [[ -n "$OLLAMA_NOTE" ]] && yellow "  ${OLLAMA_NOTE}"
  $NO_SEARCH && yellow "  --no-search: bundled SearXNG disabled (add Brave/Tavily keys in the admin panel for web search)"
  green "  COMPOSE_PROFILES=${profiles_csv:-<none>}"
  if ! $NO_CALLS && $DOCKER_DESKTOP && ! grep -qE '^LIVEKIT_NODE_IP=' .env; then
    calls_ip="$(lan_ip)"
    if [[ -n "$calls_ip" ]]; then
      set_env_line LIVEKIT_NODE_IP "$calls_ip"
      green "  Calls: advertising this computer's LAN address ${calls_ip}"
    else
      yellow "  Calls: couldn't find this computer's LAN address; set LIVEKIT_NODE_IP in .env"
    fi
  fi
else
  yellow "  COMPOSE_PROFILES already set, leaving untouched (re-run with --with-ollama/--no-search to change)"
fi

# A host Ollama is wired whenever one is detected and nothing is set yet —
# not only when the profile block above runs. Respect an operator-set URL.
# The host.docker.internal alias is provided to the backend + worker in
# compose via extra_hosts (works on Linux/Unraid too, not just Docker
# Desktop).
if [[ "$OLLAMA_MODE" == "host" ]] && ! grep -qE '^OLLAMA_URL=' .env; then
  printf 'OLLAMA_URL=http://host.docker.internal:11434\n' >> .env
  green "  OLLAMA_URL -> the Ollama running on this machine"
  [[ "$(uname -s)" == "Linux" ]] \
    && yellow "  If the backend can't reach it, start host Ollama with OLLAMA_HOST=0.0.0.0"
fi

# ---------- 4. build + start ----------
if $NO_START; then
  echo
  green "The folder is set up; nothing was built or started (--no-start)."
  echo "  Settings are in $ROOT_DIR/.env (the web port is NGINX_HTTP_PORT)."
  echo "  When you're ready:  cd \"$ROOT_DIR\" && ./install.sh"
  exit 0
fi

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
suffix=""
[[ "$http_port" != "80" ]] && suffix=":${http_port}"
echo "    http://localhost${suffix}"
lan_ip=$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null) | awk '{print $1}' || true)
[[ -n "$lan_ip" ]] && echo "    http://${lan_ip}${suffix}   (from other devices on your network)"
echo
setup_code=$(grep -E '^SETUP_TOKEN=' .env | cut -d= -f2- || true)
if [[ -n "$setup_code" && "$setup_code" != change-me* ]]; then
  echo "  Setup code (asked for when you create the admin account): ${setup_code}"
  echo
fi
echo "  The setup wizard walks you through your admin account, a model"
echo "  provider, the public URL, embeddings, email and two-step verification."
if [[ "$OLLAMA_MODE" == "cloud" ]]; then
  echo
  yellow "  Note: no local-model runtime. Connect a cloud provider (OpenAI,"
  yellow "  Anthropic, OpenRouter, ...) in the wizard. For local models, run"
  yellow "  Ollama natively and re-run, or install with --with-ollama."
fi
if grep -qE '^COMPOSE_PROFILES=.*maps' .env; then
  echo
  yellow "  Note: P Maps is building Australia's map data in the background: about"
  yellow "  an hour and 15 GB of disk (7 GB after). Everything else works meanwhile."
  yellow "  For another country, or to turn it off, see \"P Maps\" in .env."
fi
if grep -qE '^COMPOSE_PROFILES=.*calls' .env; then
  echo
  yellow "  Voice channels: turn them on in Admin -> Calls. For voice from outside"
  yellow "  your home, forward UDP 7882 and TCP 7881 on your router to this machine."
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

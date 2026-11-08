#!/usr/bin/env bash
# Run a separate copy of Promptly for a worktree, on its own port, for
# browser and e2e testing, without touching the main app (:8091), the
# Passwords stack (:8092) or any other stack.
#
#   scripts/stack.sh up <name> [--with LIST] [--e2e] [--build-extras] [--no-build]
#       Build THIS worktree's code and start it as stack <name>. Prints the URL
#       (the first free port from 8093). Run it again to rebuild after a change;
#       the data stays. First visit to the URL runs the setup wizard.
#         --with LIST     comma-separated extras on top of the core
#                         (postgres, redis, backend, arq-worker, mail-worker,
#                         collab, frontend, nginx):
#                           media      media-worker + tusd (photos, videos, big uploads)
#                           photos-ml  photo understanding (reads the main checkout's
#                                      data/models read-only if it has them)
#                           ollama     local embeddings/models (pulls ~270 MB first start)
#                           maps       a stub map, so the Maps screen opens
#                           maps-full  the real maps container (~1 h and ~15 GB on first start)
#                           sandbox    code interpreter
#                           voice      whisper + tts
#                           convert    Office previews (Gotenberg)
#                           search     SearXNG
#                           all        everything above except maps-full
#         --e2e           add what the e2e suite exercises (media, photos-ml, maps, convert)
#         --build-extras  build sandbox/whisper/tts/photos-ml/maps from this worktree
#                         too (default: reuse the main app's promptly-<svc>:latest
#                         image when there is one, read-only)
#         --no-build      start with the images already built for this stack
#
#   scripts/stack.sh down <name> [--keep-images]
#       Stop it and delete its containers, volumes (all its data), network,
#       state and its own :stack-<name> images.
#
#   scripts/stack.sh ls
#       Stacks that exist, their ports, URL and worktree.
#
#   scripts/stack.sh e2e <name> [playwright args]
#       Run the e2e suite (the stack's worktree's e2e/) against it, e.g.
#         scripts/stack.sh e2e notes tests/chat.spec.ts
#       Wait ~45 s between runs (login rate limit). Bring the stack up with
#       --e2e for the specs that need media, photos or maps.
#
#   scripts/stack.sh compose <name> <compose args>
#       Any docker compose command on the stack, e.g.
#         scripts/stack.sh compose notes logs -f backend
#         scripts/stack.sh compose notes ps
#
# How it works: `up` renders this worktree's docker-compose.yml into a
# standalone compose file (scripts/stack-render.py) with the project
# promptly-stack-<name>, containers Promptly<Name>-*, images
# promptly-<svc>:stack-<name>, named volumes, its own networks and one port,
# 127.0.0.1:<port>. Throwaway secrets, no provider keys; the real .env is
# never read. State (compose.json, stack.env, stack.json) lives in the
# gitignored .stacks/<name>/ of the worktree. Windows: Git Bash, or
# scripts/stack.ps1 from PowerShell.
set -euo pipefail
export MSYS_NO_PATHCONV=1

here="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "stack.sh: needs python 3" >&2; exit 1; }

die() { echo "stack.sh: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# The worktree whose code a stack runs: the checkout you're in, else the
# one this script lives in.
worktree() {
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$top" ] && [ -f "$top/docker-compose.yml" ]; then echo "$top"; return; fi
  (cd "$here/.." && (pwd -W 2>/dev/null || pwd))
}
main_root() {
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$common" ] && dirname "$common" || true
}

check_name() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] && [ "${#1}" -le 24 ] \
    || die "stack name '${1:-}': lowercase letters and digits (dashes between), up to 24 characters"
}

# meta <file> <key>: a field of stack.json.
meta() { "$PY" -c 'import json,sys; v=json.load(open(sys.argv[1]))[sys.argv[2]]; print(",".join(v) if isinstance(v,list) else v)' "$1" "$2"; }

# The state folder of stack <name>: this worktree's, else whichever worktree
# its containers say.
find_state() {
  local name="$1" wt state
  wt="$(worktree)"
  if [ -f "$wt/.stacks/$name/stack.json" ]; then echo "$wt/.stacks/$name"; return; fi
  state="$(docker ps -a --filter "label=com.docker.compose.project=promptly-stack-$name" \
    --format '{{.Label "promptly.stack.state"}}' | head -n1)"
  [ -n "$state" ] && echo "$state" || true
}

dc() { docker compose -f "$STATE/compose.json" "$@"; }

wait_health() {
  local url="$1" i
  for i in $(seq 1 90); do
    if curl -fsS --max-time 3 "$url/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

cmd_up() {
  local name="${1:-}"; shift || true
  check_name "$name"
  local with="" e2e="" build_extras="" build="--build"
  while [ $# -gt 0 ]; do
    case "$1" in
      --with) with="${2:-}"; shift 2 ;;
      --with=*) with="${1#--with=}"; shift ;;
      --e2e) e2e="--e2e"; shift ;;
      --build-extras) build_extras="--build-extras"; shift ;;
      --no-build) build=""; shift ;;
      *) die "up: unknown option $1" ;;
    esac
  done
  local wt; wt="$(worktree)"
  STATE="$wt/.stacks/$name"
  local start=$SECONDS out port
  out="$("$PY" "$here/stack-render.py" --name "$name" --worktree "$wt" --state "$STATE" \
    --main-root "$(main_root "$wt")" --with "$with" $e2e $build_extras)" || exit 1
  port="${out##*PORT=}"
  echo "stack $name: $(meta "$STATE/stack.json" services | tr ',' ' ')"
  echo "  worktree $wt"
  dc up -d $build --remove-orphans --wait --wait-timeout 900
  local url="http://localhost:$port"
  wait_health "$url" || die "$url/api/health isn't answering; see: scripts/stack.sh compose $name logs backend"
  echo
  echo "stack $name is up: $url  ($(( SECONDS - start ))s)"
  echo "  containers $(meta "$STATE/stack.json" prefix)-*   e2e: scripts/stack.sh e2e $name"
}

cmd_down() {
  local name="${1:-}"; shift || true
  check_name "$name"
  local keep_images=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep-images) keep_images=1; shift ;;
      *) die "down: unknown option $1" ;;
    esac
  done
  local project="promptly-stack-$name"
  STATE="$(find_state "$name")"
  docker rm -f "$project-e2e-mock" >/dev/null 2>&1 || true
  if [ -n "$STATE" ] && [ -f "$STATE/compose.json" ]; then
    dc down -v --remove-orphans --timeout 30
  fi
  # Whatever's left with the project's label (a lost state folder, a
  # half-finished up).
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
  ids="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  [ -z "$ids" ] || docker volume rm $ids >/dev/null
  ids="$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
  [ -z "$ids" ] || docker network rm $ids >/dev/null
  if [ -z "$keep_images" ]; then
    # Only this stack's own tags; an image another tag also names stays.
    ids="$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E "^promptly-[a-z0-9-]+:stack-$name\$" || true)"
    [ -z "$ids" ] || docker image rm $ids >/dev/null
  fi
  if [ -n "$STATE" ] && [ -f "$STATE/stack.json" ] && [ "$(basename "$(dirname "$STATE")")" = ".stacks" ]; then
    rm -rf "$STATE"
  fi
  echo "stack $name: removed"
}

cmd_ls() {
  local rows
  rows="$(docker ps -a --filter label=promptly.stack.name \
    --format '{{.Label "promptly.stack.name"}}|{{.Label "promptly.stack.port"}}|{{.State}}|{{.Label "promptly.stack.worktree"}}')"
  if [ -z "$rows" ]; then echo "no stacks"; return; fi
  printf '%s\n' "$rows" | awk -F'|' '
    { n[$1]=$1; p[$1]=$2; w[$1]=$4; t[$1]++; if ($3=="running") r[$1]++ }
    END {
      printf "%-20s %-6s %-26s %-10s %s\n", "NAME", "PORT", "URL", "RUNNING", "WORKTREE"
      for (k in n) printf "%-20s %-6s %-26s %-10s %s\n", k, p[k], "http://localhost:" p[k], (r[k]+0) "/" t[k], w[k]
    }'
}

cmd_e2e() {
  local name="${1:-}"; shift || true
  check_name "$name"
  STATE="$(find_state "$name")"
  [ -n "$STATE" ] && [ -f "$STATE/stack.json" ] || die "no stack $name (scripts/stack.sh up $name --e2e)"
  local port prefix project image wt url
  port="$(meta "$STATE/stack.json" port)"
  prefix="$(meta "$STATE/stack.json" prefix)"
  project="$(meta "$STATE/stack.json" project)"
  image="$(meta "$STATE/stack.json" backend_image)"
  wt="$(meta "$STATE/stack.json" worktree)"
  url="http://localhost:$port"
  curl -fsS --max-time 5 "$url/api/health" >/dev/null 2>&1 || die "stack $name isn't answering at $url"
  cd "$wt/e2e"
  if [ ! -d node_modules ]; then
    npm ci
    npx playwright install chromium
  fi
  export E2E_BASE_URL="$url"
  export E2E_BACKEND_CONTAINER="$prefix-Backend"
  export E2E_BACKEND_IMAGE="$image"
  export E2E_NETWORK="${project}_promptly"
  export E2E_MOCK_CONTAINER="$project-e2e-mock"
  export E2E_AUTH_DIR="$STATE/e2e-auth"
  echo "e2e against $url (backend $E2E_BACKEND_CONTAINER)"
  exec npx playwright test "$@"
}

cmd_compose() {
  local name="${1:-}"; shift || true
  check_name "$name"
  STATE="$(find_state "$name")"
  [ -n "$STATE" ] && [ -f "$STATE/compose.json" ] || die "no stack $name"
  dc "$@"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  ls) cmd_ls ;;
  e2e) shift; cmd_e2e "$@" ;;
  compose) shift; cmd_compose "$@" ;;
  -h|--help|help) usage ;;
  *) usage 1 ;;
esac

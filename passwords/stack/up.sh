#!/usr/bin/env bash
# Bring up the isolated :8092 stack. Generates throwaway secrets on first run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$here/.env" ]; then
  umask 077
  {
    echo "SECRET_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    echo "POSTGRES_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
    echo "PASSWORDS_E2E=1"
  } > "$here/.env"
fi
exec docker compose -f "$here/docker-compose.yml" --env-file "$here/.env" up -d "$@"

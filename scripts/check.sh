#!/usr/bin/env bash
# Promptly's pre-release check (see scripts/check.mjs for the options).
#   scripts/check.sh                       everything but the browser suite
#   scripts/check.sh --only backend        one step
#   scripts/check.sh --with e2e            and the browser suite
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "node isn't installed (the frontend needs it too)." >&2; exit 2; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check.mjs" "$@"

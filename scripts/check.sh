#!/usr/bin/env bash
# Promptly's pre-release check (see scripts/check.mjs for the options).
#   scripts/check.sh                       everything (about an hour)
#   scripts/check.sh --quick               everything but the browser suite (about 11 minutes)
#   scripts/check.sh --only backend        one step
#   scripts/check.sh --only e2e            the browser suite alone (it adds up with an earlier --quick on the same code)
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "node isn't installed (the frontend needs it too)." >&2; exit 2; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check.mjs" "$@"

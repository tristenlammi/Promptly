#!/usr/bin/env bash
# ============================================================
# Promptly — recovery kit (Linux / macOS)
#
#   ./scripts/recovery-kit.sh [output-file]   (default: ./promptly-recovery-kit.txt)
#
# Writes everything needed to get your data back on a new machine if this
# one is lost: where the off-site copies are, the password that decrypts
# them, the target's credentials, and SECRET_KEY. Print it or keep it in a
# password manager — somewhere that ISN'T this machine.
#
# Runs only on the host. Promptly never serves this over the web.
# ============================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
OUT="${1:-$ROOT_DIR/promptly-recovery-kit.txt}"
umask 077

docker compose exec -T backend python -m app.cli recovery-kit > "$OUT"
printf 'Recovery kit written to %s (readable by you only).\n' "$OUT"
printf 'Move it off this machine, then delete this copy.\n'

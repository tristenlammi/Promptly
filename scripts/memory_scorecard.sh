#!/usr/bin/env bash
# The memory scorecard (backend/tests/test_memory_eval.py), against a throwaway
# database. It reads the chat provider from the real install without changing it,
# and spends a little on real model calls.
#
#   scripts/memory_scorecard.sh [where-to-write-results.json]
set -u
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
B="$(pwd -W 2>/dev/null || pwd)/backend"
NAME="promptly_test_memeval_$$"
docker compose run --rm --no-deps -v "$B/app:/app/app" -v "$B/tests:/app/tests" -v "$B/alembic:/app/alembic" \
  -e MEMORY_EVAL=1 -e MEMORY_EVAL_OUT=/app/tests/memory_eval/last_run.json -e MEMORY_EVAL_SET="${MEMORY_EVAL_SET:-golden.json}" \
  -e MEMORY_EVAL_MODEL="${MEMORY_EVAL_MODEL:-anthropic/claude-haiku-5.5}" \
  -e MEMORY_EVAL_DB="postgresql+asyncpg://promptly:promptly@postgres:5432/${POSTGRES_DB:-promptly}" \
  -e TEST_DATABASE_URL="postgresql+asyncpg://promptly:promptly@postgres:5432/$NAME" \
  --entrypoint python backend -m pytest tests/test_memory_eval.py -q -s -p no:cacheprovider -W ignore --no-header --tb=short </dev/null 2>&1 \
  | grep -vE '^ *(Container|Network) |^$'
docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS $NAME'" 2>&1 | tail -1
[ -n "${1:-}" ] && cp backend/tests/memory_eval/last_run.json "$1"
exit 0

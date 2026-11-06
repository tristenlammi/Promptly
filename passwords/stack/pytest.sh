#!/usr/bin/env bash
# Run backend tests against the isolated stack's Postgres and Redis, in a
# throwaway container on a scratch database: never the dev stack, never with
# the app preloaded. One run at a time (each run truncates its database).
#   bash passwords/stack/pytest.sh tests/test_passwords.py -x -q
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && (pwd -W 2>/dev/null || pwd))"
# shellcheck disable=SC1091
. "$here/.env"
export MSYS_NO_PATHCONV=1
name="promptly-pw-pytest-$$"
db="${PW_TEST_DB:-promptly_pw_test}"
exec docker run --rm --name "$name" --network promptly-pw \
  -e "DATABASE_URL=postgresql+asyncpg://promptly:${POSTGRES_PASSWORD}@postgres:5432/promptly" \
  -e "TEST_DATABASE_URL=postgresql+asyncpg://promptly:${POSTGRES_PASSWORD}@postgres:5432/${db}" \
  -e "REDIS_URL=redis://redis:6379/1" \
  -e "PROMPTLY_REQUIRE_DB_TESTS=1" \
  -e "PYTHONDONTWRITEBYTECODE=1" \
  -e "COOKIE_SECURE=false" \
  -v "$root/backend/app:/app/app" \
  -v "$root/backend/alembic:/app/alembic" \
  -v "$root/backend/tests:/app/tests" \
  -v "$root/backend/alembic.ini:/app/alembic.ini" \
  -v "$root/backend/pytest.ini:/app/pytest.ini" \
  --entrypoint python \
  promptly-pw-backend:local -m pytest "$@"

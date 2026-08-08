"""Shared pytest configuration for the backend suite.

Ensures the FastAPI app's top-level ``app`` package is importable when
pytest is invoked from the repo root (via ``pytest backend/tests``)
rather than from inside the ``backend/`` directory. ``asyncio_mode =
auto`` lives in ``pytest.ini`` so every ``async def test_*`` runs
without per-test ``@pytest.mark.asyncio`` ceremony.

It also provides the database harness. Until now every test was a pure
unit test with hand-rolled stubs, which left the chat/streaming path —
the most critical code in the app — with no coverage at all, because it
genuinely needs a database to do anything. The fixtures below give it one.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# ---------------------------------------------------------------------
# Point the app at a scratch database — BEFORE any ``app.*`` import.
#
# ``app.database`` builds its engine and ``SessionLocal`` at import time
# from ``get_settings()``, which reads this env var and is lru_cached. And
# modules do ``from app.database import SessionLocal``, capturing the
# object by value — so patching it afterwards would miss most callers.
# Setting the env here, at conftest import (which pytest performs before
# collecting any test module), is what makes the whole app talk to the
# test database instead of the real one.
#
# Same server and credentials, different database name: a test can never
# touch real data, and the harness can drop/recreate freely.
# ---------------------------------------------------------------------
_REAL_DB = os.environ.get(
    "DATABASE_URL", "postgresql+asyncpg://promptly:promptly@postgres:5432/promptly"
)
_TEST_DB = os.environ.get("TEST_DATABASE_URL") or _REAL_DB.rsplit("/", 1)[0] + "/promptly_test"
os.environ["DATABASE_URL"] = _TEST_DB

import asyncio  # noqa: E402
import uuid  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import pytest  # noqa: E402


def _sync_dsn(url: str) -> str:
    """asyncpg DSN (no SQLAlchemy driver prefix) for raw admin work."""
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def _ensure_database() -> None:
    """Create the scratch database if it isn't there yet."""
    import asyncpg

    admin_dsn = _sync_dsn(_TEST_DB).rsplit("/", 1)[0] + "/postgres"
    name = _TEST_DB.rsplit("/", 1)[1]
    conn = await asyncpg.connect(admin_dsn)
    try:
        exists = await conn.fetchval(
            "select 1 from pg_database where datname = $1", name
        )
        if not exists:
            await conn.execute(f'create database "{name}"')
    finally:
        await conn.close()


async def _reset_redis() -> None:
    """Drop the shared redis client's pooled connections.

    Same hazard as the DB engine: ``app.redis_client.redis`` is a
    module-level singleton whose connections bind to the loop that opened
    them, so a pool built in one test is unusable in the next
    ("attached to a different loop"). The streaming path uses redis for the
    stream context, so this bites any test that drives a generation.
    """
    try:
        from app.redis_client import redis

        await redis.aclose()
    except Exception:  # noqa: BLE001 — best effort between tests
        pass


@pytest.fixture(scope="session")
def database():
    """A migrated scratch database, or skip.

    Skips rather than fails when Postgres isn't reachable so the pure-unit
    tests still run for someone without the Docker stack up. Deliberately
    runs the real Alembic chain rather than ``create_all`` — the schema
    under test should be the schema that ships, and it means a migration
    that doesn't apply cleanly fails the suite.

    Session-scoped and synchronous: Alembic is sync, and a sync fixture
    sidesteps pytest-asyncio's per-function event-loop scoping.
    """
    try:
        asyncio.run(_ensure_database())
    except Exception as exc:  # noqa: BLE001
        # Locally, skip so someone without the Docker stack up can still run
        # the pure-unit tests. In CI, fail: a silent skip there would mean a
        # green run that proved nothing about the most critical path in the
        # app, which is exactly the failure mode this harness exists to end.
        if os.environ.get("PROMPTLY_REQUIRE_DB_TESTS") == "1":
            pytest.fail(
                f"PROMPTLY_REQUIRE_DB_TESTS=1 but Postgres is unreachable: {exc}"
            )
        pytest.skip(f"Postgres unavailable for DB-backed tests: {exc}")

    from app.bootstrap import run_migrations

    run_migrations()
    yield _TEST_DB


@pytest.fixture
async def db(database):
    """A session against the scratch database.

    Each test gets a clean slate via truncation rather than a rolled-back
    outer transaction: the code under test calls ``SessionLocal()`` and
    commits on its own, so it would never join an outer transaction anyway.
    """
    from app.database import SessionLocal, engine
    from sqlalchemy import text

    # asyncpg binds each connection to the event loop that opened it, and
    # pytest-asyncio hands every test a fresh loop — so a pooled connection
    # from the previous test is poison here ("attached to a different
    # loop"). Dispose on the way in and out so each test pools its own.
    await engine.dispose()
    await _reset_redis()

    # Wipe between tests. ``truncate ... cascade`` on the tables the app
    # writes is far faster than dropping/recreating the schema, and keeps
    # alembic_version intact so migrations run once per session.
    async with engine.begin() as conn:
        rows = await conn.execute(
            text(
                "select tablename from pg_tables where schemaname='public' "
                "and tablename <> 'alembic_version'"
            )
        )
        names = [r[0] for r in rows]
        if names:
            await conn.execute(
                text(
                    "truncate table "
                    + ", ".join(f'"{n}"' for n in names)
                    + " restart identity cascade"
                )
            )

    async with SessionLocal() as session:
        yield session

    await engine.dispose()
    await _reset_redis()


# ---------------------------------------------------------------------
# Row factories — the minimum needed to exercise a chat turn.
# ---------------------------------------------------------------------
@pytest.fixture
async def user(db):
    from app.auth.models import User

    row = User(
        email=f"test-{uuid.uuid4().hex[:8]}@example.com",
        username=f"tester{uuid.uuid4().hex[:6]}",
        password_hash="x",
        role="admin",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.fixture
async def provider(db):
    from app.models_config.models import ModelProvider

    row = ModelProvider(
        user_id=None,
        name="Test provider",
        type="openai_compatible",
        base_url="http://stub.invalid/v1",
        api_key=None,
        enabled=True,
        models=[{"id": "test-model", "name": "Test Model"}],
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.fixture
async def conversation(db, user, provider):
    from app.chat.models import Conversation

    row = Conversation(
        user_id=user.id,
        title="Test chat",
        provider_id=provider.id,
        model_id="test-model",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row

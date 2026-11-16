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

# Run in parallel (``pytest -n 6``, which is what scripts/check does): each
# pytest-xdist worker gets a database of its own, ``<name>_gw0`` …, copied
# from one migrated template (``<name>_tmpl``) so the Alembic chain runs once
# per run and not once per worker. A plain ``pytest`` (no -n) is one
# database, migrated in place, as before.
#
# Redis too: tests never use database 0, which is the running stack's (its
# sessions, rate limits and caches used to be shared with every test run,
# and a cached answer from one run made the next run's "was the map asked?"
# assertions fail). Worker N uses database N+1, a plain run uses 15, and
# each is emptied when its session starts.
_WORKER = os.environ.get("PYTEST_XDIST_WORKER", "")
_BASE_DB = _TEST_DB
_n = 14
if _WORKER:
    _TEST_DB = f"{_BASE_DB}_{_WORKER}"
    _n = int("".join(ch for ch in _WORKER if ch.isdigit()) or 0) % 14
_redis = os.environ.get("REDIS_URL", "redis://redis:6379/0")
os.environ["REDIS_URL"] = _redis.rsplit("/", 1)[0] + f"/{1 + _n}"
os.environ["DATABASE_URL"] = _TEST_DB

# And at a scratch uploads folder: the test container mounts the real
# ./data/uploads, so a test that didn't point storage elsewhere wrote its
# blobs into the live install (rows in the test DB, bytes in real data) —
# the integrity scrubber found them as orphans (WP-7.2). Tests that set
# their own UPLOAD_ROOT still do.
import tempfile  # noqa: E402

os.environ["PROMPTLY_UPLOAD_ROOT"] = tempfile.mkdtemp(prefix="promptly-test-uploads-")

# And a signing key, where none is set: the app refuses to boot on the dev
# placeholder, so a bare ``pytest`` (CI has no .env) errored on every test
# that imported ``app.main``. A random one per run is all a test needs.
if not os.environ.get("SECRET_KEY"):
    import secrets  # noqa: E402

    os.environ["SECRET_KEY"] = secrets.token_urlsafe(48)

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


# ---------------------------------------------------------------------
# Wiping between tests.
#
# This used to be ``truncate <every table> restart identity cascade``: about
# 220 tables, each one a new file on disk, 2-8 seconds a test on a busy
# machine — most of the suite's hour. A test touches a handful of tables, so
# the scratch database now notes which ones (a statement trigger per table
# writes the name into ``_test_dirty``) and the wipe empties only those.
# Test-only plumbing in the scratch database; nothing in the app knows.
# ---------------------------------------------------------------------
_PREPARE_SQL = """
create unlogged table if not exists _test_dirty (t text not null);
create or replace function _test_mark() returns trigger language plpgsql as $f$
begin
  if not exists (select 1 from _test_dirty where t = tg_table_name) then
    insert into _test_dirty (t) values (tg_table_name);
  end if;
  return null;
end $f$;
do $$
declare r record;
begin
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname not in ('alembic_version', '_test_dirty')
      and not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = '_test_mark')
  loop
    execute format('create trigger _test_mark after insert on %I for each statement execute function _test_mark()', r.relname);
  end loop;
end $$;
"""

# Tables the dirty list names, plus any table that has no trigger yet (one a
# test's own migration made): those are checked the slow way. Foreign keys
# are off for the delete (``replica``), since every table with rows is being
# emptied anyway; sequences go back to the start, as ``restart identity`` did.
_WIPE_SQL = """
do $$
declare t text; hit int;
begin
  set local session_replication_role = replica;
  for t in
    select distinct d.t from _test_dirty d join pg_class c on c.relname = d.t and c.relkind = 'r'
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  loop
    execute format('delete from %I', t);
  end loop;
  delete from _test_dirty;
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname not in ('alembic_version', '_test_dirty')
      and not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = '_test_mark')
  loop
    execute format('select 1 from %I limit 1', t) into hit;
    if hit is not null then execute format('delete from %I', t); end if;
    hit := null;
  end loop;
  for t in
    select format('%I.%I', schemaname, sequencename) from pg_sequences
    where schemaname = 'public' and last_value is not null
  loop
    execute 'alter sequence ' || t || ' restart';
  end loop;
end $$;
"""


async def _prepare_database(dsn: str) -> None:
    """Empty a freshly migrated database (rows the migrations seeded went
    with the first truncate before, too) and start noting dirty tables."""
    import asyncpg

    conn = await asyncpg.connect(dsn)
    try:
        names = [
            r[0]
            for r in await conn.fetch(
                "select tablename from pg_tables where schemaname='public' "
                "and tablename not in ('alembic_version', '_test_dirty')"
            )
        ]
        if names:
            await conn.execute(
                "truncate table " + ", ".join(f'"{n}"' for n in names) + " restart identity cascade"
            )
        await conn.execute(_PREPARE_SQL)
    finally:
        await conn.close()


def _migrate_in_subprocess(url: str) -> None:
    """Run the Alembic chain against ``url`` in a process of its own: this
    one's settings are already bound to the worker's database."""
    import subprocess

    env = dict(os.environ, DATABASE_URL=url)
    env.pop("TEST_DATABASE_URL", None)
    done = subprocess.run(
        [sys.executable, "-c", "from app.bootstrap import run_migrations; run_migrations()"],
        cwd=str(BACKEND_ROOT), env=env, capture_output=True, text=True,
    )
    if done.returncode != 0:
        raise RuntimeError(
            "migrating the template database failed:\n" + done.stdout[-2000:] + "\n" + done.stderr[-4000:]
        )


async def _template_is_current(dsn: str) -> bool:
    import asyncpg
    from alembic.script import ScriptDirectory

    from app.bootstrap import _alembic_cfg

    heads = set(ScriptDirectory.from_config(_alembic_cfg()).get_heads())
    try:
        conn = await asyncpg.connect(dsn)
    except Exception:  # noqa: BLE001
        return False
    try:
        have = {r[0] for r in await conn.fetch("select version_num from alembic_version")}
        marked = await conn.fetchval("select 1 from pg_tables where tablename = '_test_dirty'")
    except Exception:  # noqa: BLE001
        return False
    finally:
        await conn.close()
    return bool(marked) and have == heads


async def _copy_from_template() -> None:
    """This worker's database, copied from the run's migrated template. The
    first worker to get here builds the template; the rest wait on a
    Postgres advisory lock and then just copy."""
    import asyncpg

    admin_dsn = _sync_dsn(_BASE_DB).rsplit("/", 1)[0] + "/postgres"
    base = _BASE_DB.rsplit("/", 1)[1]
    tmpl, mine = f"{base}_tmpl", _TEST_DB.rsplit("/", 1)[1]
    conn = await asyncpg.connect(admin_dsn)
    try:
        await conn.execute("select pg_advisory_lock(hashtext($1))", tmpl)
        try:
            url = _BASE_DB.rsplit("/", 1)[0] + f"/{tmpl}"
            if await conn.fetchval("select 1 from pg_database where datname = $1", tmpl):
                # Left by an earlier run under the same name: only good if it
                # was migrated by this code.
                if not await _template_is_current(_sync_dsn(url)):
                    await conn.execute(f'drop database "{tmpl}" with (force)')
            if not await conn.fetchval("select 1 from pg_database where datname = $1", tmpl):
                await conn.execute(f'create database "{tmpl}"')
                try:
                    await asyncio.to_thread(_migrate_in_subprocess, url)
                    await _prepare_database(_sync_dsn(url))
                except BaseException:
                    await conn.execute(f'drop database if exists "{tmpl}" with (force)')
                    raise
            await conn.execute(f'drop database if exists "{mine}" with (force)')
            await conn.execute(f'create database "{mine}" template "{tmpl}"')
        finally:
            await conn.execute("select pg_advisory_unlock(hashtext($1))", tmpl)
    finally:
        await conn.close()


async def _stop_leftover_tasks() -> None:
    """End what a test left running on its event loop: fire-and-forget work
    (``app.background.spawn``: the error-log write, a stream's delayed
    eviction, a notification) outlives the request that started it, and the
    loop closes under it. That was the "Task was destroyed but it is
    pending" and "Logging error" noise at the end of every run, and a
    half-finished write is what used to leave locks behind for the next
    test's wipe."""
    try:
        from app import background
    except Exception:  # noqa: BLE001
        return
    loop = asyncio.get_running_loop()
    mine = [t for t in list(background._background_tasks) if t.get_loop() is loop and not t.done()]
    for t in mine:
        t.cancel()
    if mine:
        await asyncio.gather(*mine, return_exceptions=True)
    # Tasks from an earlier, closed loop can never finish: forget them.
    for t in list(background._background_tasks):
        if t.get_loop() is not loop:
            background._background_tasks.discard(t)


async def _empty_redis() -> None:
    """A clean Redis database for this session (never database 0)."""
    url = os.environ["REDIS_URL"]
    if url.rsplit("/", 1)[1] in ("", "0"):
        return
    try:
        from redis.asyncio import from_url

        client = from_url(url)
        try:
            await client.flushdb()
        finally:
            await client.aclose()
    except Exception:  # noqa: BLE001 — no Redis: the tests that need it say so
        pass


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


@pytest.fixture(autouse=True)
def _no_photos_ml(monkeypatch):
    """No test talks to a real photos-ml service (the test container is on
    the compose network, where one may be running); tests that need it fake
    ``app.photos.ml``."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "PHOTOS_ML_URL", "")
    import app.photos.ml as ml

    monkeypatch.setattr(ml, "_health", (0.0, None))

    # The face check's captions (face_check): a neutral answer — every face
    # stays a face — unless a test fakes the text side itself.
    async def neutral_texts(texts):
        return "stub", [[0.0] * 768 for _ in texts]

    monkeypatch.setattr(ml, "embed_texts", neutral_texts)


@pytest.fixture(autouse=True)
def _own_restore_scratch(monkeypatch):
    """The off-site restore test restores into a scratch database with one
    fixed name (``promptly_restore_test``), on whatever server it's pointed
    at. Tests get one of their own per test database, so two workers, two
    runs, or a run and the stack itself can't drop each other's."""
    try:
        import app.backups.offsite as offsite
    except Exception:  # noqa: BLE001
        return
    monkeypatch.setattr(offsite, "_SCRATCH_DB", _TEST_DB.rsplit("/", 1)[1] + "_restore")


# The tests that use the throwaway mail server (MAIL_TEST_HOST) empty it
# between tests, so only one module of them may be at it at a time. With
# several workers that needs a turn: a file lock, held for the module. A
# module is one of them if it has test_mail's ``live`` mark and its ``server``
# fixture (test_mail itself, and whatever imports them from it).
@pytest.fixture(scope="module", autouse=True)
def _mail_server_turn(request):
    uses = hasattr(request.module, "live") and hasattr(request.module, "server")
    if not uses or not os.environ.get("MAIL_TEST_HOST"):
        yield
        return
    import fcntl

    path = Path(tempfile.gettempdir()) / f"promptly-mail-{os.environ['MAIL_TEST_HOST']}.lock"
    with open(path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


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
        asyncio.run(_copy_from_template() if _WORKER else _ensure_database())
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

    if not _WORKER:
        from app.bootstrap import run_migrations

        run_migrations()
        asyncio.run(_prepare_database(_sync_dsn(_TEST_DB)))
    asyncio.run(_empty_redis())
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

    # Wipe between tests: only the tables the last test wrote to (see
    # _WIPE_SQL). alembic_version stays, so migrations run once per session.
    async with engine.begin() as conn:
        # A background write from the previous test (an error-log row, a
        # notification) can be cut off mid-transaction when its event loop
        # closes, leaving a connection that holds locks for ever — the
        # wipe below then waited indefinitely and the suite "hung".
        # End any such leftovers first.
        await conn.execute(
            text(
                "select pg_terminate_backend(pid) from pg_stat_activity "
                "where datname = current_database() and pid <> pg_backend_pid()"
            )
        )
        await conn.execute(text(_WIPE_SQL))

    async with SessionLocal() as session:
        yield session

    await _stop_leftover_tasks()
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

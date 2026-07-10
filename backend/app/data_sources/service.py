"""Read-only query execution against an admin-configured data source.

Security model (why this is safe to expose to workspace editors):
* Editors never supply connection details — only a ``SELECT`` against a source
  an admin registered. So this can't be pointed at an arbitrary host.
* **Read-only, enforced two ways:** a syntactic guard (single statement, must
  begin with ``SELECT``/``WITH``) *and* an actual ``READ ONLY`` transaction —
  so even a data-modifying CTE (``WITH x AS (INSERT …)``) is rejected by the DB.
* **Bounded:** per-statement timeout, connection timeout, and a hard row cap
  fetched via a server-side cursor (so a huge table doesn't load into memory).
* Values are coerced to JSON-safe primitives before they leave here.

Postgres-only (asyncpg). One-off connection per run — no shared pool, closed in
a ``finally``.
"""
from __future__ import annotations

import datetime as _dt
import decimal
import ipaddress
import re
import uuid as _uuid
from typing import Any

import asyncpg

from app.auth.utils import decrypt_secret
from app.data_sources.models import DataSource

# Hard limits.
ROW_CAP = 1000
STATEMENT_TIMEOUT_MS = 15_000
CONNECT_TIMEOUT_S = 10

# A single leading SELECT/WITH is the only thing we run. Comments stripped
# first so ``/* */ select 1`` still passes and ``select 1; drop table`` fails.
_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


class DataSourceError(Exception):
    """A query couldn't be run — safe to surface to the caller."""


def _strip_comments(sql: str) -> str:
    return _BLOCK_COMMENT.sub(" ", _LINE_COMMENT.sub(" ", sql))


def is_read_only_query(sql: str) -> bool:
    """True only for a single ``SELECT``/``WITH`` statement (the syntactic
    half of the guard — the READ ONLY transaction is the real backstop)."""
    s = _strip_comments(sql or "").strip().rstrip(";").strip()
    if not s or ";" in s:  # reject empty + multi-statement
        return False
    low = s.lower()
    return low.startswith("select") or low.startswith("with")


def _json_safe(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, decimal.Decimal):
        # keep integers exact-ish, floats as float
        return float(v)
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, _uuid.UUID):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "<binary>"
    if isinstance(
        v, (ipaddress.IPv4Address, ipaddress.IPv6Address, ipaddress.IPv4Network, ipaddress.IPv6Network)
    ):
        return str(v)
    return str(v)


def _ssl_arg(source: DataSource):
    return "require" if (source.sslmode or "").lower() == "require" else False


async def _connect(source: DataSource) -> asyncpg.Connection:
    if (source.driver or "postgres") != "postgres":
        raise DataSourceError(
            f"Unsupported driver {source.driver!r} (only Postgres is supported)."
        )
    password = (
        decrypt_secret(source.password_encrypted)
        if source.password_encrypted
        else None
    )
    try:
        return await asyncpg.connect(
            host=source.host,
            port=source.port,
            user=source.username,
            password=password,
            database=source.database,
            ssl=_ssl_arg(source),
            timeout=CONNECT_TIMEOUT_S,
        )
    except (OSError, asyncpg.PostgresError) as exc:
        raise DataSourceError(f"Couldn't connect: {exc}") from exc
    except ValueError as exc:
        # e.g. bad SECRET_KEY when decrypting the password
        raise DataSourceError(f"Connection is misconfigured: {exc}") from exc


async def run_query(source: DataSource, sql: str) -> dict:
    """Run ``sql`` read-only against ``source`` → ``{columns, rows, truncated,
    row_count}``. Raises :class:`DataSourceError` on any problem."""
    if not is_read_only_query(sql):
        raise DataSourceError(
            "Only a single read-only SELECT (or WITH … SELECT) query is allowed."
        )
    conn = await _connect(source)
    try:
        async with conn.transaction(readonly=True):
            await conn.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
            # Server-side cursor: fetch at most ROW_CAP+1 so we can flag
            # truncation without pulling the whole result set into memory.
            cursor = await conn.cursor(sql.strip().rstrip(";"))
            records = await cursor.fetch(ROW_CAP + 1)
    except asyncpg.PostgresError as exc:
        raise DataSourceError(f"Query failed: {getattr(exc, 'message', str(exc))}") from exc
    except Exception as exc:  # noqa: BLE001 — asyncpg timeouts et al.
        raise DataSourceError(f"Query failed: {exc}") from exc
    finally:
        await conn.close()

    truncated = len(records) > ROW_CAP
    records = records[:ROW_CAP]
    columns = list(records[0].keys()) if records else []
    rows = [[_json_safe(v) for v in rec.values()] for rec in records]
    return {
        "columns": columns,
        "rows": rows,
        "truncated": truncated,
        "row_count": len(rows),
    }


async def test_connection(source: DataSource) -> None:
    """Ping the source (``SELECT 1``). Raises :class:`DataSourceError` on
    failure; returns None on success."""
    conn = await _connect(source)
    try:
        async with conn.transaction(readonly=True):
            await conn.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
            await conn.fetchval("SELECT 1")
    except Exception as exc:  # noqa: BLE001
        raise DataSourceError(f"Test query failed: {exc}") from exc
    finally:
        await conn.close()

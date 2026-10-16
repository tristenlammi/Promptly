"""Database dumps — before every migration, nightly, and on demand (WP-0.2).

Promptly had no backups of its own: an update applied data-deleting
migrations with nothing to roll back to, and the published advice ("copy
./data") copied a live Postgres directory and left out the key that
decrypts every stored secret. This module takes ``pg_dump -Fc`` dumps into
``/app/backups`` (``./data/backups`` on the host):

* ``pre-migrate-<rev>-<ts>.dump`` whenever the schema is about to change;
* ``nightly-<ts>.dump`` at 02:00 (arq cron), keeping the last 14;
* ``manual-<ts>.dump`` from Admin → Backups.

Every attempt is a ``backup_runs`` row; a failure alerts every admin.

The dump client must match the server's major version — a newer
``pg_dump`` writes dumps an older server can refuse to load — so the image
pins ``postgresql-client-15`` for the pg15 server, and this refuses to run
if the two ever disagree.

A dump holds the database only. Restoring also needs ``./data/uploads``
(the files) and ``.env`` (``SECRET_KEY`` decrypts provider keys and other
secrets); ``scripts/backup.sh`` bundles all three.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

from sqlalchemy import select, text

from app.config import get_settings

logger = logging.getLogger("promptly.backups")

BACKUP_DIR = Path(os.environ.get("PROMPTLY_BACKUP_DIR", "/app/backups"))
KEEP = {"nightly": 14, "pre_migrate": 10, "manual": 10}
_PREFIX = {"nightly": "nightly", "pre_migrate": "pre-migrate", "manual": "manual"}
DUMP_TIMEOUT_S = 60 * 60


class BackupError(RuntimeError):
    """A dump couldn't be taken; ``str(e)`` is fit to show an admin."""


@dataclass
class DumpResult:
    path: Path
    size_bytes: int


def _conn_env() -> tuple[list[str], dict[str, str]]:
    """libpq args + env from DATABASE_URL (password via env, never argv)."""
    url = urlparse(get_settings().DATABASE_URL.replace("+asyncpg", ""))
    args = [
        "-h", url.hostname or "postgres",
        "-p", str(url.port or 5432),
        "-U", unquote(url.username or "promptly"),
        "-d", (url.path or "/promptly").lstrip("/") or "promptly",
    ]
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = unquote(url.password)
    return args, env


async def _run(cmd: list[str], env: dict[str, str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "timed out"
    return proc.returncode or 0, (err or out or b"").decode("utf-8", "replace").strip()


async def client_major() -> int:
    """Major version of the bundled ``pg_dump``."""
    try:
        code, out = await _run(["pg_dump", "--version"], dict(os.environ), 30)
    except FileNotFoundError as e:
        raise BackupError("pg_dump isn't installed in this image.") from e
    m = re.search(r"(\d+)(?:\.\d+)?", out)
    if code != 0 or not m:
        raise BackupError(f"Couldn't run pg_dump: {out[:200]}")
    return int(m.group(1))


async def server_major(db) -> int:
    num = (await db.execute(text("SHOW server_version_num"))).scalar_one()
    return int(num) // 10000


def _prune(kind: str) -> None:
    prefix = _PREFIX[kind] + "-"
    dumps = sorted(
        (p for p in BACKUP_DIR.glob(prefix + "*.dump") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in dumps[KEEP[kind]:]:
        try:
            old.unlink()
        except OSError:
            logger.warning("couldn't prune old backup %s", old.name)


async def dump_database(kind: str, *, label: str = "", server_version: int | None = None) -> DumpResult:
    """Write a ``pg_dump -Fc`` of the whole database and prune old ones.

    Writes to ``*.partial`` and renames on success, so a half-written dump
    is never mistaken for a good one.
    """
    if kind not in _PREFIX:
        raise ValueError(kind)
    major = await client_major()
    if server_version is not None and server_version != major:
        raise BackupError(
            f"pg_dump {major} doesn't match the PostgreSQL {server_version} server; "
            "a dump from it might not restore. Rebuild the backend image."
        )
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = "-".join(x for x in (_PREFIX[kind], re.sub(r"[^A-Za-z0-9_.]", "", label)[:40], ts) if x)
    final = BACKUP_DIR / f"{name}.dump"
    partial = final.with_suffix(".dump.partial")
    args, env = _conn_env()
    code, msg = await _run(
        ["pg_dump", "-Fc", "--no-owner", "-f", str(partial), *args], env, DUMP_TIMEOUT_S
    )
    if code != 0:
        partial.unlink(missing_ok=True)
        raise BackupError(f"pg_dump failed: {msg[:400]}")
    os.replace(partial, final)
    _prune(kind)
    return DumpResult(path=final, size_bytes=final.stat().st_size)


async def _current_revision(db) -> str | None:
    try:
        return (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar_one_or_none()
    except Exception:  # noqa: BLE001 — fresh database
        return None


async def _alert_admins(db, title: str, body: str) -> None:
    from app.auth.models import User
    from app.mfa.smtp import send_message
    from app.notifications.dispatch import notify_user

    admins = (await db.execute(select(User).where(User.role == "admin", User.disabled.is_(False)))).scalars().all()
    for a in admins:
        await notify_user(
            user_id=a.id, category="system_alert", title=title, body=body,
            url="/admin?tab=backups", tag="promptly-backup-failed",
        )
        try:
            await send_message(db, to=a.email, subject=f"Promptly: {title}", text_body=body)
        except Exception:  # noqa: BLE001 — SMTP is optional; the push still went
            pass


async def run_backup(kind: str) -> "BackupRun":  # noqa: F821
    """Take a recorded dump (``nightly`` / ``manual``). Never raises; a
    failure is recorded and every admin is alerted."""
    from app.backups.models import BackupRun
    from app.database import SessionLocal

    async with SessionLocal() as db:
        run = BackupRun(kind=kind, status="running", revision=await _current_revision(db))
        db.add(run)
        await db.commit()
        try:
            res = await dump_database(kind, server_version=await server_major(db))
            run.status = "ok"
            run.filename = res.path.name
            run.size_bytes = res.size_bytes
        except Exception as e:  # noqa: BLE001
            logger.exception("%s backup failed", kind)
            run.status = "failed"
            run.error = str(e)[:2000]
        run.finished_at = datetime.now(timezone.utc)
        await db.commit()
        if run.status == "failed":
            await _alert_admins(
                db,
                "Database backup failed",
                f"The {kind} database backup failed: {run.error[:300]} — "
                "see Admin → Backups.",
            )
        await db.refresh(run)
        return run


__all__ = ["BACKUP_DIR", "BackupError", "dump_database", "run_backup", "server_major"]

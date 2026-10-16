"""Off-site backup with restic (WP-2.3, D11).

The dumps in ``./data/backups`` protect against a bad update, not a dead
disk, a stolen box or a house fire: they sit on the machine they protect.
This sends encrypted, deduplicated snapshots to a target the admin picks in
Admin → Backups:

* ``folder`` — a USB disk or NAS share, mounted on the host at
  ``OFFSITE_BACKUP_DIR`` (``/app/offsite`` in here);
* ``s3`` — Amazon S3, Backblaze B2 (its S3 API), Wasabi, MinIO…;
* ``sftp`` — another machine over SSH;
* ``rest`` — restic's rest-server (best run ``--append-only``, so a
  compromised Promptly can't delete its own backups).

Each copy holds the database dumps, the uploads and whiteboards, and a
config snapshot (``SECRET_KEY`` etc. — without it a restore can't decrypt
stored keys). Everything is encrypted with a repository password that is
generated once and kept here (encrypted) and in the recovery kit
(``scripts/recovery-kit.sh``, host-only, never served over HTTP).

Nightly copy, weekly integrity check of a twelfth of the stored data, and a
monthly trial restore into a scratch database with sampled file hashes —
because a backup that has never been restored is a hope, not a backup.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import secrets
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from sqlalchemy import func, select, text

from app.auth.utils import decrypt_secret, encrypt_secret
from app.backups.models import BackupRun, OffsiteBackupConfig
from app.backups.service import BACKUP_DIR, _alert_admins, _conn_env, dump_database, server_major
from app.config import get_settings

logger = logging.getLogger("promptly.backups.offsite")

TARGETS = ("folder", "s3", "sftp", "rest")
OFFSITE_ROOT = Path(os.environ.get("PROMPTLY_OFFSITE_DIR", "/app/offsite"))
BACKUP_PATHS = ["/app/backups", "/app/uploads", "/app/whiteboard"]
# Rebuildable or transient: thumbnails/previews, half-finished uploads,
# quarantined files, half-written dumps, the restore test's own scratch.
# Unfinished big uploads and import archives (WP-8.2, WP-10.1) are transient too.
EXCLUDES = ["derived", ".staging", ".quarantine", ".tus", ".imports", "*.partial", "restore-test"]
COPY_TIMEOUT_S = 6 * 60 * 60
CHECK_TIMEOUT_S = 6 * 60 * 60
STALE_AFTER = timedelta(hours=48)
RESTORE_SAMPLE_FILES = 50
_SCRATCH_DB = "promptly_restore_test"


class OffsiteError(RuntimeError):
    """Fit to show an admin."""


# ---------------------------------------------------------------- config


async def load_config(db) -> OffsiteBackupConfig:
    cfg = await db.get(OffsiteBackupConfig, 1)
    if cfg is None:
        cfg = OffsiteBackupConfig(id=1)
        db.add(cfg)
        await db.flush()
    return cfg


def credentials(cfg: OffsiteBackupConfig) -> dict[str, str]:
    if not cfg.credentials_encrypted:
        return {}
    try:
        return json.loads(decrypt_secret(cfg.credentials_encrypted))
    except (ValueError, json.JSONDecodeError):
        return {}


def set_credentials(cfg: OffsiteBackupConfig, creds: dict[str, str]) -> None:
    clean = {k: v for k, v in creds.items() if v}
    cfg.credentials_encrypted = encrypt_secret(json.dumps(clean)) if clean else None


def repo_password(cfg: OffsiteBackupConfig) -> str:
    """The repository's encryption password, created on first use."""
    if not cfg.repo_password_encrypted:
        cfg.repo_password_encrypted = encrypt_secret(secrets.token_urlsafe(32))
    return decrypt_secret(cfg.repo_password_encrypted)


def repository(cfg: OffsiteBackupConfig) -> str:
    """The restic repository string for the configured target."""
    loc = (cfg.location or "").strip()
    if cfg.target_kind == "folder":
        sub = loc.strip("/").replace("..", "") or "promptly"
        return str(OFFSITE_ROOT / sub)
    if cfg.target_kind == "s3":
        # "https://s3.us-west-002.backblazeb2.com/bucket/promptly"
        if not loc.startswith(("http://", "https://")):
            loc = "https://" + loc
        return f"s3:{loc.rstrip('/')}"
    if cfg.target_kind == "sftp":
        # "backup@nas.lan:/volume1/promptly"
        return f"sftp:{loc}"
    if cfg.target_kind == "rest":
        return f"rest:{loc.rstrip('/')}/"
    raise OffsiteError(f"Unknown target {cfg.target_kind!r}.")


@contextlib.asynccontextmanager
async def _restic_env(cfg: OffsiteBackupConfig) -> AsyncIterator[tuple[dict[str, str], list[str]]]:
    """Environment and extra flags for one restic call; secrets go via the
    environment or a 0600 temp file, never the command line."""
    creds = credentials(cfg)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "RESTIC_REPOSITORY": repository(cfg),
        "RESTIC_PASSWORD": repo_password(cfg),
        "RESTIC_CACHE_DIR": str(BACKUP_DIR / ".restic-cache"),
    }
    extra: list[str] = []
    tmpdir: str | None = None
    try:
        if cfg.target_kind == "s3":
            env["AWS_ACCESS_KEY_ID"] = creds.get("access_key_id", "")
            env["AWS_SECRET_ACCESS_KEY"] = creds.get("secret_access_key", "")
            if creds.get("region"):
                env["AWS_DEFAULT_REGION"] = creds["region"]
        elif cfg.target_kind == "rest":
            if creds.get("username"):
                env["RESTIC_REST_USERNAME"] = creds["username"]
                env["RESTIC_REST_PASSWORD"] = creds.get("password", "")
        elif cfg.target_kind == "sftp":
            tmpdir = tempfile.mkdtemp(prefix="promptly-ssh-")
            known = BACKUP_DIR / ".ssh_known_hosts"
            args = f"-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={known} -o BatchMode=yes"
            if creds.get("private_key"):
                key = Path(tmpdir) / "id"
                key.write_text(creds["private_key"].strip() + "\n")
                key.chmod(0o600)
                args = f"-i {key} -o IdentitiesOnly=yes " + args
            extra = ["-o", f"sftp.args={args}"]
        yield env, extra
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


async def _restic(cfg: OffsiteBackupConfig, args: list[str], *, timeout: float = 600) -> tuple[int, str, str]:
    """Run restic; ``(exit code, stdout, stderr)``."""
    async with _restic_env(cfg) as (env, extra):
        try:
            proc = await asyncio.create_subprocess_exec(
                "restic", *extra, *args, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            raise OffsiteError("restic isn't installed in this image — rebuild the backend.") from e
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return 124, "", "timed out"
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _explain(stderr: str) -> str:
    """The useful line of restic's output, for an admin."""
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    for ln in lines:
        low = ln.lower()
        if "fatal" in low or "error" in low or "denied" in low or "invalid" in low:
            return ln[:400]
    return (lines[-1] if lines else "restic failed")[:400]


async def ensure_repository(cfg: OffsiteBackupConfig) -> bool:
    """Make sure the target holds a repository; create one if it's empty.
    Returns True when one was created."""
    if cfg.target_kind == "folder":
        OFFSITE_ROOT.mkdir(parents=True, exist_ok=True)
    code, _out, err = await _restic(cfg, ["cat", "config"], timeout=120)
    if code == 0:
        return False
    low = err.lower()
    missing = code == 10 or "does not exist" in low or "is there a repository" in low or "no such file" in low
    if not missing:
        raise OffsiteError(_explain(err))
    code, _out, err = await _restic(cfg, ["init"], timeout=300)
    if code != 0:
        raise OffsiteError(_explain(err))
    return True


async def test_target(cfg: OffsiteBackupConfig) -> dict[str, Any]:
    """Reach the target (creating the repository if it's new) and count
    what's there."""
    created = await ensure_repository(cfg)
    code, out, err = await _restic(cfg, ["snapshots", "--json"], timeout=300)
    if code != 0:
        raise OffsiteError(_explain(err))
    snaps = json.loads(out or "[]")
    return {
        "ok": True,
        "created": created,
        "snapshots": len(snaps),
        "latest": snaps[-1]["time"] if snaps else None,
    }


# ---------------------------------------------------------------- runs


async def _record(kind: str) -> BackupRun:
    from app.database import SessionLocal

    async with SessionLocal() as db:
        run = BackupRun(kind=kind, status="running")
        db.add(run)
        await db.commit()
        await db.refresh(run)
        return run


async def _finish(run_id, *, status: str, filename: str | None = None, size: int | None = None,
                  detail: str | None = None, error: str | None = None, alert: tuple[str, str] | None = None) -> None:
    from app.database import SessionLocal

    async with SessionLocal() as db:
        run = await db.get(BackupRun, run_id)
        run.status = status
        run.filename = filename
        run.size_bytes = size
        run.detail = detail
        run.error = error
        run.finished_at = datetime.now(timezone.utc)
        await db.commit()
        if alert:
            await _alert_admins(db, *alert)


def _config_snapshot(dirpath: Path) -> None:
    """What a restore needs besides the data: the keys that decrypt it."""
    s = get_settings()
    payload = {
        "written_at": datetime.now(timezone.utc).isoformat(),
        "promptly_version": os.environ.get("PROMPTLY_VERSION", ""),
        "SECRET_KEY": s.SECRET_KEY,
        "SECRET_KEY_PREVIOUS": s.SECRET_KEY_PREVIOUS,
        "note": (
            "Put SECRET_KEY into the new install's .env before restoring the "
            "database, or stored provider keys, MFA and connector secrets can't "
            "be decrypted."
        ),
    }
    f = dirpath / "promptly-config.json"
    f.write_text(json.dumps(payload, indent=2))
    f.chmod(0o600)


async def run_offsite() -> None:
    """Send a copy to the target, then apply retention. Never raises; a
    failure is recorded and every admin is alerted."""
    from app.database import SessionLocal

    run = await _record("offsite")
    workdir = Path(tempfile.mkdtemp(prefix="promptly-config-"))
    try:
        async with SessionLocal() as db:
            cfg = await load_config(db)
            if not cfg.enabled:
                raise OffsiteError("Off-site backup isn't switched on.")
            repo_password(cfg)
            await db.commit()
            # Make sure there's a recent database dump to send.
            dumps = sorted(BACKUP_DIR.glob("*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
            fresh = dumps and datetime.now(timezone.utc).timestamp() - dumps[0].stat().st_mtime < 26 * 3600
            if not fresh:
                await dump_database("nightly", server_version=await server_major(db))
            await ensure_repository(cfg)
            _config_snapshot(workdir)
            paths = [p for p in BACKUP_PATHS if Path(p).exists()] + [str(workdir)]
            args = ["backup", "--json", "--tag", "promptly", "--host", "promptly"]
            for pat in EXCLUDES:
                args += ["--exclude", pat]
            code, out, err = await _restic(cfg, args + paths, timeout=COPY_TIMEOUT_S)
            if code not in (0, 3):  # 3 = some files unreadable, snapshot still made
                raise OffsiteError(_explain(err))
            summary: dict[str, Any] = {}
            for line in out.splitlines():
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("message_type") == "summary":
                    summary = msg
            code, _o, err2 = await _restic(cfg, [
                "forget", "--prune", "--tag", "promptly",
                "--keep-daily", str(cfg.keep_daily),
                "--keep-weekly", str(cfg.keep_weekly),
                "--keep-monthly", str(cfg.keep_monthly),
            ], timeout=COPY_TIMEOUT_S)
            note = "" if code == 0 else f" (couldn't prune old copies: {_explain(err2)})"
        detail = (
            f"{summary.get('total_files_processed', 0)} files, "
            f"{_human(summary.get('data_added', 0))} new" + (" — some files couldn't be read" if code == 3 else "") + note
        )
        await _finish(run.id, status="ok", filename=(summary.get("snapshot_id") or "")[:12] or None,
                      size=summary.get("total_bytes_processed"), detail=detail)
    except Exception as e:  # noqa: BLE001
        logger.exception("off-site backup failed")
        msg = str(e) if isinstance(e, OffsiteError) else f"Unexpected error: {e}"
        await _finish(run.id, status="failed", error=msg[:2000],
                      alert=("Off-site backup failed", f"Tonight's off-site copy failed: {msg[:300]} — see Admin → Backups."))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def run_check() -> None:
    """Weekly: read back a twelfth of the stored data and verify it, so
    corruption at the target shows up before it's needed."""
    from app.database import SessionLocal

    run = await _record("check")
    try:
        async with SessionLocal() as db:
            cfg = await load_config(db)
        code, _o, err = await _restic(cfg, ["check", "--read-data-subset=1/12"], timeout=CHECK_TIMEOUT_S)
        if code != 0:
            raise OffsiteError(_explain(err))
        await _finish(run.id, status="ok", detail="Copies checked (1/12 of the data read back).")
    except Exception as e:  # noqa: BLE001
        logger.exception("off-site check failed")
        msg = str(e)
        await _finish(run.id, status="failed", error=msg[:2000],
                      alert=("Off-site backup check failed", f"The weekly check of the off-site copies failed: {msg[:300]}"))


async def _pg(cmd: list[str], *, database: str, timeout: float = 3600) -> tuple[int, str]:
    """A PostgreSQL client command against ``database``. createdb/dropdb
    take the name as an argument; the others as ``-d``."""
    from app.backups.service import _run

    args, env = _conn_env()
    i = args.index("-d")
    conn = args[:i] + args[i + 2:]
    if cmd[0] in ("createdb", "dropdb"):
        full = [*cmd, *conn, database]
    else:
        full = [*cmd, *conn, "-d", database]
    return await _run(full, env, timeout)


async def run_restore_test() -> None:
    """Monthly: restore the newest database dump from the off-site copy
    into a scratch database, compare it with the live one, and check a
    sample of files byte for byte. Cleans up after itself."""
    from app.database import SessionLocal
    from app.files.models import UserFile
    from app.files.storage import absolute_path

    run = await _record("restore_test")
    scratch = BACKUP_DIR / "restore-test"
    try:
        async with SessionLocal() as db:
            cfg = await load_config(db)
            sample = list((await db.execute(
                select(UserFile.storage_path).order_by(func.random()).limit(RESTORE_SAMPLE_FILES)
            )).scalars())
            from app.auth.models import User
            from app.chat.models import Conversation, Message

            tables = [m.__tablename__ for m in (User, Conversation, Message, UserFile)]
            live = {t: (await db.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() for t in tables}
        newest = max(BACKUP_DIR.glob("*.dump"), key=lambda p: p.stat().st_mtime, default=None)
        if newest is not None and shutil.disk_usage(BACKUP_DIR).free < newest.stat().st_size * 4:
            await _finish(run.id, status="skipped", detail="Skipped — not enough free disk space for a trial restore.")
            return
        shutil.rmtree(scratch, ignore_errors=True)
        scratch.mkdir(parents=True)
        code, _o, err = await _restic(cfg, [
            "restore", "latest", "--tag", "promptly", "--target", str(scratch),
            "--include", f"{BACKUP_DIR}/*.dump",
        ], timeout=CHECK_TIMEOUT_S)
        if code != 0:
            raise OffsiteError(f"Couldn't restore from the off-site copy: {_explain(err)}")
        restored = max(
            (scratch / str(BACKUP_DIR).lstrip("/")).glob("*.dump"), key=lambda p: p.stat().st_mtime, default=None
        )
        if restored is None:
            raise OffsiteError("The latest off-site copy has no database dump in it.")

        await _pg(["dropdb", "--if-exists"], database=_SCRATCH_DB)
        code, msg = await _pg(["createdb"], database=_SCRATCH_DB)
        if code != 0:
            raise OffsiteError(f"Couldn't create a scratch database: {msg[:300]}")
        try:
            code, msg = await _pg(["pg_restore", "--no-owner", "--exit-on-error", str(restored)], database=_SCRATCH_DB)
            if code != 0:
                raise OffsiteError(f"The database dump didn't restore: {msg[:300]}")
            counts: dict[str, int] = {}
            for table in live:
                code, out = await _pg(["psql", "-tAc", f"SELECT count(*) FROM {table}"], database=_SCRATCH_DB)
                counts[table] = int(out.strip() or 0) if code == 0 else -1
        finally:
            await _pg(["dropdb", "--if-exists"], database=_SCRATCH_DB)
        if counts.get("users", 0) <= 0:
            raise OffsiteError("The restored database has no users — the copy looks empty.")

        checked = mismatched = 0
        for rel in sample:
            local = absolute_path(rel)
            if not local.is_file():
                continue
            code, data = await _dump_file(cfg, str(local))
            if code != 0:
                continue  # added after the latest copy
            checked += 1
            if hashlib.sha256(data).digest() != _sha256(local):
                mismatched += 1
        if mismatched:
            raise OffsiteError(f"{mismatched} of {checked} sampled files differ from the off-site copy.")
        detail = (
            f"Restored {restored.name}: " + ", ".join(f"{k} {counts[k]}/{live[k]}" for k in live)
            + f" (copy/live); {checked} sampled files match."
        )
        await _finish(run.id, status="ok", detail=detail)
    except Exception as e:  # noqa: BLE001
        logger.exception("restore test failed")
        msg = str(e)
        await _finish(run.id, status="failed", error=msg[:2000],
                      alert=("Backup restore test failed", f"This month's trial restore failed: {msg[:300]}"))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


async def _dump_file(cfg: OffsiteBackupConfig, path: str) -> tuple[int, bytes]:
    async with _restic_env(cfg) as (env, extra):
        proc = await asyncio.create_subprocess_exec(
            "restic", *extra, "dump", "--tag", "promptly", "latest", path, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _err = await asyncio.wait_for(proc.communicate(), timeout=600)
    return proc.returncode or 0, out


def _sha256(path: Path) -> bytes:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.digest()


def _human(n: int | float) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ---------------------------------------------------------------- schedule


async def tick() -> None:
    """Hourly from the worker: run whatever is due."""
    from app.database import SessionLocal

    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        cfg = await db.get(OffsiteBackupConfig, 1)
        if cfg is None or not cfg.enabled or now.hour != cfg.hour:
            return

        async def last(kind: str) -> datetime | None:
            return (await db.execute(
                select(BackupRun.created_at).where(BackupRun.kind == kind)
                .order_by(BackupRun.created_at.desc()).limit(1)
            )).scalar_one_or_none()

        due_copy = (await last("offsite") or datetime.min.replace(tzinfo=timezone.utc)) < now - timedelta(hours=20)
        due_check = now.weekday() == 6 and (await last("check") or datetime.min.replace(tzinfo=timezone.utc)) < now - timedelta(days=6)
        due_test = cfg.restore_test_enabled and now.day == 1 and (
            await last("restore_test") or datetime.min.replace(tzinfo=timezone.utc)
        ) < now - timedelta(days=25)
    if due_copy:
        await run_offsite()
    if due_check:
        await run_check()
    if due_test:
        await run_restore_test()


# ---------------------------------------------------------------- status


@dataclass
class OffsiteStatus:
    configured: bool
    healthy: bool
    # Why it's amber or red, in a sentence; ``None`` when all's well.
    warning: str | None
    last_copy: BackupRun | None
    last_copy_ok: BackupRun | None
    last_check: BackupRun | None
    last_restore_test: BackupRun | None


async def status(db) -> OffsiteStatus:
    cfg = await db.get(OffsiteBackupConfig, 1)

    async def latest(kind: str, ok_only: bool = False) -> BackupRun | None:
        q = select(BackupRun).where(BackupRun.kind == kind)
        if ok_only:
            q = q.where(BackupRun.status == "ok")
        return (await db.execute(q.order_by(BackupRun.created_at.desc()).limit(1))).scalar_one_or_none()

    last_copy, last_ok = await latest("offsite"), await latest("offsite", ok_only=True)
    last_check, last_test = await latest("check"), await latest("restore_test")
    configured = bool(cfg and cfg.enabled)
    warning: str | None = None
    if not configured:
        warning = "Not a real backup yet: every copy is on this machine. Set up an off-site target below."
    elif last_ok is None:
        warning = "Off-site backup is set up but hasn't completed yet."
    elif datetime.now(timezone.utc) - last_ok.created_at > STALE_AFTER:
        warning = "The last good off-site copy is more than two days old."
    elif last_copy and last_copy.status == "failed":
        warning = "The latest off-site copy failed."
    elif last_test and last_test.status == "failed":
        warning = "The last trial restore failed."
    return OffsiteStatus(
        configured=configured, healthy=warning is None, warning=warning,
        last_copy=last_copy, last_copy_ok=last_ok, last_check=last_check, last_restore_test=last_test,
    )


def recovery_kit_text(cfg: OffsiteBackupConfig) -> str:
    """Everything needed to get the data back on a new machine. Printed by
    ``python -m app.cli recovery-kit`` (host only — never over HTTP)."""
    s = get_settings()
    creds = credentials(cfg)
    lines = [
        "PROMPTLY RECOVERY KIT — keep this somewhere safe, away from this machine.",
        f"Written {datetime.now(timezone.utc).isoformat()}",
        "",
        "== Off-site backup ==",
        f"Target: {cfg.target_kind}",
        f"Repository: {repository(cfg) if cfg.location or cfg.target_kind == 'folder' else '(not set)'}",
        f"Repository password (RESTIC_PASSWORD): {repo_password(cfg) if cfg.repo_password_encrypted else '(not created yet)'}",
    ]
    for k, v in creds.items():
        if k == "private_key":
            lines += ["SSH private key:", v]
        else:
            lines.append(f"{k}: {v}")
    lines += [
        "",
        "== Promptly secrets (.env) ==",
        f"SECRET_KEY={s.SECRET_KEY}",
    ]
    if s.SECRET_KEY_PREVIOUS:
        lines.append(f"SECRET_KEY_PREVIOUS={s.SECRET_KEY_PREVIOUS}")
    lines += [
        "",
        "== Restoring ==",
        "1. Install Promptly on the new machine and put SECRET_KEY above into its .env.",
        "2. restic -r <repository> restore latest --tag promptly --target /tmp/promptly-restore",
        "   (with RESTIC_PASSWORD and the target credentials above set in the environment).",
        "3. Copy app/uploads and app/whiteboard into ./data, and restore the newest",
        "   app/backups/*.dump with ./scripts/restore.sh.",
    ]
    return "\n".join(lines) + "\n"

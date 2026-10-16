"""Import jobs: where their archive parts live, and indexing them (WP-10.1).

Parts are uploaded through tusd like any big upload (WP-8.2) but kept out
of Drive, in ``UPLOAD_ROOT/.imports/<job>/`` — they're the person's own
archives for the length of the import, not their files, so they don't count
against their storage (the disk guard still applies). Finished, cancelled
or failed-and-abandoned imports have their parts deleted.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("promptly.imports")

PART_EXTS = (".zip", ".tgz", ".tar.gz", ".tar")
MAX_PARTS = 100
STALE_DAYS = 14


def imports_root() -> Path:
    from app.files import storage

    return storage.UPLOAD_ROOT / ".imports"


def job_dir(job_id: uuid.UUID | str) -> Path:
    return imports_root() / str(uuid.UUID(str(job_id)))


def part_ext(name: str) -> str | None:
    low = name.lower()
    return next((e for e in PART_EXTS if low.endswith(e)), None)


def plan_path(job_id: uuid.UUID | str) -> Path:
    return job_dir(job_id) / "plan.json"


def remove_files(job_id: uuid.UUID | str) -> None:
    shutil.rmtree(job_dir(job_id), ignore_errors=True)


async def index(job_id: uuid.UUID | str) -> str:
    """Read every part, match photos with their details, and write the plan
    and the dry-run report. Returns the job's state."""
    from app.database import SessionLocal
    from app.imports.models import ImportJob
    from app.imports.takeout import build_plan, scan_part

    jid = uuid.UUID(str(job_id))
    async with SessionLocal() as db:
        job = await db.get(ImportJob, jid)
        if job is None or job.state != "indexing":
            return job.state if job else "gone"
        parts = list(job.parts or [])
        source = job.source
    try:
        if not parts:
            raise ValueError("Upload the archive parts first.")
        if source == "takeout":
            scans = [await asyncio.to_thread(scan_part, job_dir(jid) / p["file"], i) for i, p in enumerate(parts)]
            plan, report = await asyncio.to_thread(build_plan, scans)
            plan["source"] = "takeout"
        else:
            # A folder of photos or an Apple export (WP-10.3).
            from app.imports import folders

            scans = [await asyncio.to_thread(folders.scan_part, job_dir(jid) / p["file"], i) for i, p in enumerate(parts)]
            plan, report = await asyncio.to_thread(
                lambda: folders.build_plan(scans, source=source, archive_names=[p["name"] for p in parts])
            )
        if not plan["photos"] and not plan["drive"]:
            raise ValueError("There are no photos, videos or files in these archives.")
        await asyncio.to_thread(plan_path(jid).write_text, json.dumps(plan), "utf-8")
        state, error = "ready", None
    except Exception as exc:  # noqa: BLE001 — told to the person, not raised
        logger.warning("indexing import %s failed", jid, exc_info=True)
        report, state, error = None, "failed", _say(exc)
    async with SessionLocal() as db:
        job = await db.get(ImportJob, jid)
        if job is None or job.state != "indexing":
            return job.state if job else "gone"
        job.state, job.report, job.error = state, report, error
        await db.commit()
    return state


def _say(exc: Exception) -> str:
    import tarfile
    import zipfile

    if isinstance(exc, (zipfile.BadZipFile, tarfile.TarError, EOFError)):
        return "One of the parts isn't a complete archive — it may not have finished downloading. Remove it and upload it again."
    if isinstance(exc, ValueError):
        return str(exc)
    return "The archives couldn't be read."


async def enqueue_index(job_id: uuid.UUID) -> None:
    from app.tasks.queue import INDEX_IMPORT, get_pool

    try:
        pool = await get_pool()
        await pool.enqueue_job(INDEX_IMPORT, str(job_id), _job_id=f"import-index-{job_id}-{datetime.now(timezone.utc).timestamp()}")
        return
    except Exception:  # noqa: BLE001
        logger.warning("enqueue_index: queue unavailable, indexing inline", exc_info=True)
    from app.background import spawn

    spawn(index(job_id), name=f"import_index_{job_id}")


async def sweep() -> int:
    """Parts of imports left alone for two weeks (never imported, failed,
    abandoned) are deleted; the job says so."""
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.imports.models import ImportJob

    cutoff = datetime.now(timezone.utc) - timedelta(days=STALE_DAYS)
    n = 0
    async with SessionLocal() as db:
        jobs = (
            await db.execute(
                select(ImportJob).where(
                    ImportJob.state.in_(("collecting", "ready", "failed")), ImportJob.updated_at < cutoff
                )
            )
        ).scalars().all()
        for job in jobs:
            await asyncio.to_thread(remove_files, job.id)
            job.state, job.parts, job.error = "cancelled", [], "Not imported within two weeks, so its uploaded parts were deleted."
            n += 1
        await db.commit()
    return n


__all__ = ["MAX_PARTS", "PART_EXTS", "enqueue_index", "imports_root", "index", "job_dir", "part_ext", "plan_path", "remove_files", "sweep"]

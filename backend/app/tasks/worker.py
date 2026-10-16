"""Arq worker for scheduled-automation runs.

Run in its own container: ``arq app.tasks.worker.WorkerSettings``. It pulls
``execute_task_run`` jobs off Redis and executes them via the same
:func:`app.tasks.runner.execute_run` the API used to call inline — but out of
the API process, so redeploys of the API don't kill in-flight runs.
"""
from __future__ import annotations

import uuid

from arq.connections import RedisSettings
from arq.cron import cron
from arq.worker import func

from app.config import get_settings
from app.tasks.queue import BUILD_ZIP, INDEX_IMPORT, RUN_IMPORT, RUN_MEETING, RUN_TASK


async def execute_task_run(ctx, run_id: str) -> None:
    """Arq job: execute one already-created pending TaskRun to completion.
    ``execute_run`` owns its own DB session and never raises (every failure is
    recorded on the run row), so a bad run can't take the worker down."""
    from app.tasks.runner import execute_run

    await execute_run(uuid.UUID(run_id))


import asyncio as _asyncio

_MEETING_SLOTS = _asyncio.Semaphore(2)


async def execute_meeting_job(ctx, job_id: str) -> None:
    """Arq job: chunk-transcribe a meeting recording and seed the notes note.
    ``execute_meeting`` owns its session and records failures on the job row."""
    from app.workspaces.meetings_runner import execute_meeting

    # Two at a time: long recordings mustn't occupy every worker slot that
    # automations need (R-151). The rest wait here — the Whisper server
    # is one model anyway.
    async with _MEETING_SLOTS:
        await execute_meeting(uuid.UUID(job_id))


async def nightly_backup(ctx) -> None:
    """Cron: dump the database (keeps 14); a failure alerts every admin."""
    from app.backups.service import run_backup

    await run_backup("nightly")


async def wait_for_schema(ctx) -> None:
    """Startup: don't run jobs until the backend has migrated the database.

    The worker shares the backend image but skips its entrypoint, so after
    an update its new code could start against the old schema (R-244).
    Waits up to 10 minutes for the database to reach this code's head
    revision, then exits so the container restarts and tries again.
    """
    import asyncio
    import logging
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from sqlalchemy import text

    from app.database import SessionLocal

    log = logging.getLogger("promptly.worker")
    root = Path(__file__).resolve().parent.parent.parent
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    head = ScriptDirectory.from_config(cfg).get_current_head()
    for attempt in range(120):
        try:
            async with SessionLocal() as db:
                current = (
                    await db.execute(text("SELECT version_num FROM alembic_version"))
                ).scalar_one_or_none()
        except Exception:  # noqa: BLE001 — DB not up yet
            current = None
        if current == head:
            return
        if attempt == 0:
            log.info("worker waiting for migrations: database at %s, code at %s", current, head)
        await asyncio.sleep(5)
    raise SystemExit("worker: the database never reached schema %s; restarting" % head)


async def refresh_connector_catalogs(ctx) -> None:
    """Every few hours: re-read each connector's tool list (R-160)."""
    from app.mcp.service import refresh_all_catalogs

    await refresh_all_catalogs()


async def offsite_backup_tick(ctx) -> None:
    """Hourly: run the off-site copy / weekly check / monthly restore test
    when they're due (WP-2.3)."""
    from app.backups.offsite import tick

    await tick()


async def storage_check(ctx) -> None:
    """Cron: the integrity scrubber (WP-7.2) — every file's presence and
    size, a rolling re-hash, and on Sundays the orphan walk."""
    from app.files.scrubber import run_check

    await run_check(trigger="nightly")


async def disk_check(ctx) -> None:
    """Cron: tell the admins when the uploads disk passes 85 % / 95 %."""
    from app.files.disk_guard import check_and_alert

    await check_and_alert()


async def hash_backfill(ctx) -> None:
    """Cron: hash files stored before hashes were recorded (WP-7.1) — a
    few minutes an hour, oldest first, until none are left."""
    from app.database import SessionLocal
    from app.files.blobstore import backfill_hashes

    async with SessionLocal() as db:
        await backfill_hashes(db, budget_seconds=240)


async def storage_maintenance(ctx) -> None:
    """Cron: Drive trash retention, orphaned assets, tombstone sweep."""
    from app.tasks.maintenance import run_storage_maintenance

    await run_storage_maintenance()


async def extract_office_text_job(ctx, file_id: str) -> bool:
    """An uploaded Word / Excel / PowerPoint file's text → content_text."""
    from app.files.office_formats import extract_and_store

    return await extract_and_store(file_id)


async def doc_thumbnail_job(ctx, file_id: str) -> bool:
    """A Doc's first-page thumbnail for the Files grid."""
    from app.files.doc_thumbs import make

    return await make(file_id)


async def convert_office_job(ctx, file_id: str) -> bool:
    """An Office file's faithful PDF preview, by the optional converter (Stage 12)."""
    from app.files.convert import convert

    return await convert(file_id)


async def render_pdf_job(ctx, page_html: str) -> bytes:
    """A Doc's PDF (WP-6.4) — rendered here so the API's one worker stays
    responsive. The result is read back by the waiting request."""
    import asyncio

    from app.files.pdf_export import html_to_pdf

    return await asyncio.to_thread(html_to_pdf, page_html)


async def build_zip_job(ctx: dict, job_id: str) -> str:
    """A zip download (WP-7.6): written to a temp file, served by nginx."""
    from app.files.zip_jobs import build

    return await build(job_id)


async def index_import_job(ctx: dict, job_id: str) -> str:
    """Read an import's archive parts and write its dry-run report (WP-10.1)."""
    from app.imports.jobs import index

    return await index(job_id)


async def run_import_job(ctx: dict, job_id: str) -> str:
    """Import a Takeout (WP-10.2) — tens of thousands of photos can take hours."""
    from app.imports.run import run

    return await run(job_id)


async def import_watchdog(ctx: dict) -> int:
    """Start again an import whose worker stopped (a restart)."""
    from app.imports.run import watchdog

    return await watchdog()


async def import_sweep(ctx: dict) -> int:
    """Delete the parts of imports left alone for two weeks."""
    from app.imports.jobs import sweep

    return await sweep()


async def tus_sweep(ctx: dict) -> int:
    """Resumable uploads nobody finished within a week (WP-8.2)."""
    import asyncio

    from app.files.tus_hooks import sweep

    return await asyncio.to_thread(sweep)


async def zip_sweep(ctx: dict) -> int:
    """Delete zip downloads older than a few hours, and the plans of
    library exports past their week (WP-10.4)."""
    import asyncio

    from app.files import library_export
    from app.files.zip_jobs import sweep

    return await asyncio.to_thread(sweep) + await asyncio.to_thread(library_export.sweep)


# Arq registers functions by their ``__name__``; pin it to the shared constant
# so the enqueue side (queue.RUN_TASK) and the worker always agree.
execute_task_run.__name__ = RUN_TASK
execute_meeting_job.__name__ = RUN_MEETING
build_zip_job.__name__ = BUILD_ZIP
index_import_job.__name__ = INDEX_IMPORT
run_import_job.__name__ = RUN_IMPORT


class WorkerSettings:
    functions = [
        # Never retried by arq: a run interrupted mid-way is closed out by
        # execute_run's pending-only guard instead of replaying its side
        # effects (R-147).
        func(execute_task_run, max_tries=1),
        # A long recording on CPU Whisper is legitimately slow — give
        # meeting jobs far more room than the 900s automation ceiling.
        func(execute_meeting_job, timeout=3 * 3600, max_tries=1),
        # A big workbook can take a while; a damaged one fails once.
        func(extract_office_text_job, timeout=300, max_tries=2),
        # LibreOffice on a big deck takes a while; the preview waits.
        func(convert_office_job, timeout=300, max_tries=1, keep_result=0),
        func(doc_thumbnail_job, timeout=120, max_tries=1, keep_result=0),
        # The API is waiting on it; keep the result just long enough to read.
        func(render_pdf_job, timeout=120, max_tries=1, keep_result=120),
        # A big selection can take a while to write; the browser polls.
        func(build_zip_job, timeout=2 * 3600, max_tries=1, keep_result=0),
        # Reading a big Takeout's parts (every member listed, sidecars parsed).
        func(index_import_job, timeout=2 * 3600, max_tries=1, keep_result=0),
        # The import itself; the watchdog restarts one that lost its worker.
        func(run_import_job, timeout=24 * 3600, max_tries=1, keep_result=0),
        # Photos and videos are the media worker's (WP-7.4,
        # app.tasks.media_worker), on their own queue.
    ]
    cron_jobs = [
        # 02:00 nightly database dump, then 03:30 storage housekeeping, so
        # anything purged today is still in last night's dump.
        cron(nightly_backup, hour=2, minute=0, run_at_startup=False, unique=True),
        cron(storage_maintenance, hour=3, minute=30, run_at_startup=False, unique=True),
        cron(offsite_backup_tick, minute=20, run_at_startup=False, unique=True),
        cron(hash_backfill, minute=40, run_at_startup=False, unique=True),
        # After storage maintenance (03:30), before the morning.
        cron(storage_check, hour=4, minute=15, run_at_startup=False, unique=True),
        cron(disk_check, minute=5, run_at_startup=False, unique=True),
        cron(zip_sweep, minute=50, run_at_startup=False, unique=True),
        cron(tus_sweep, hour=4, minute=45, run_at_startup=False, unique=True),
        cron(import_sweep, hour=4, minute=55, run_at_startup=False, unique=True),
        cron(import_watchdog, minute={1, 11, 21, 31, 41, 51}, run_at_startup=False, unique=True),
        cron(
            refresh_connector_catalogs,
            hour={1, 7, 13, 19},
            minute=15,
            run_at_startup=False,
            unique=True,
        ),
    ]
    on_startup = wait_for_schema
    redis_settings = RedisSettings.from_dsn(get_settings().REDIS_URL)
    # A run can be long (LLM turns + tool hops + web search); give it room.
    # This is now a *backstop*, not the real limit — each run computes a
    # size-aware budget (app.tasks.graph_runner.estimate_flow_timeout, capped
    # at 3000s) and enforces it itself with a clear "exceeded time budget"
    # message. The worker ceiling just sits above that cap so the blunt kill
    # never fires before the friendly one (A3).
    job_timeout = 3300
    # Room for several people at once: each person is held to
    # PER_USER_CONCURRENT_RUNS automation runs, and meeting transcription to
    # two jobs, so no one user or a pair of long recordings fills it (R-151).
    max_jobs = 8
    # Results live on the TaskRun row, not in Redis — don't retain them.
    keep_result = 0

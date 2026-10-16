"""Daily storage housekeeping, run by the arq worker (WP-0.2).

One job, three passes, each in its own transaction so one failing can't
block the others:

1. Drive trash retention — purge what's been in the trash 30+ days.
2. Orphaned document assets — images whose document no longer exists.
3. Stale document snapshots — re-render docs whose HTML missed an edit.
4. Tombstone sweep — unlink blobs whose 14-day recovery window is over.

Order matters: the first two only tombstone, so nothing they touch today
is unlinked by today's sweep.
"""
from __future__ import annotations

import logging

from app.database import SessionLocal

logger = logging.getLogger("promptly.maintenance")


async def run_storage_maintenance() -> dict[str, int]:
    from app.files.documents_router import rerender_stale_documents
    from app.files.purge import (
        purge_expired_trash,
        purge_orphan_document_assets,
        purge_unreferenced_document_assets,
    )
    from app.files.tombstones import sweep_due
    from app.files.versions import prune_versions
    from app.files.link_roles import purge_dead_link_grants
    from app.workspaces.router import purge_trashed_workspaces

    out = {
        "trash_purged": 0, "orphan_assets": 0, "docs_rerendered": 0,
        "blobs_unlinked": 0, "bytes_freed": 0,
    }
    for key, fn in (
        ("trash_purged", purge_expired_trash),
        ("orphan_assets", purge_orphan_document_assets),
        # Pictures deleted from a document a week or more ago (R-228).
        ("unused_assets", purge_unreferenced_document_assets),
        ("docs_rerendered", rerender_stale_documents),
        # Workspaces 30+ days in the trash (R-177).
        ("workspaces_purged", purge_trashed_workspaces),
        # Blobs no row references are no longer deleted here: the integrity
        # scrubber's weekly walk moves them to .quarantine/ (WP-7.2).
        # Editor snapshots: hourly for 48 h, daily for 30 days (WP-3.3).
        ("versions_pruned", prune_versions),
        # Access people got from comment / edit links that have since
        # expired (WP-6.6; the access checks already ignore them).
        ("link_grants_purged", purge_dead_link_grants),
    ):
        try:
            async with SessionLocal() as db:
                out[key] = await fn(db)
                await db.commit()
        except Exception:  # noqa: BLE001 — log and carry on with the next pass
            logger.exception("storage maintenance: %s failed", key)
    try:
        # Staged uploads a crash left behind (WP-7.1).
        from app.files.blobstore import clear_stale_staging

        out["staging_cleared"] = clear_stale_staging()
    except Exception:  # noqa: BLE001
        logger.exception("storage maintenance: staging cleanup failed")
    try:
        import asyncio

        from app.files.egress import prune_cache

        out["egress_pruned"] = await asyncio.to_thread(prune_cache)
    except Exception:  # noqa: BLE001
        logger.exception("storage maintenance: egress cache prune failed")
    # Rosters' context text is a window around today — roll it forward
    # nightly so "who's on tomorrow?" stays answerable (R-174).
    try:
        out["rosters_refreshed"] = await refresh_roster_texts()
    except Exception:  # noqa: BLE001
        logger.exception("storage maintenance: roster refresh failed")
    # Nightly safety net for anything left un-embedded (an embedder that
    # was down when the file, note or memory was saved).
    try:
        from app.custom_models.backfill import backfill_embeddings

        out["embedding_backfill"] = await backfill_embeddings(max_items=200, max_memories=500)
    except Exception:  # noqa: BLE001
        logger.exception("storage maintenance: embedding backfill failed")
    try:
        async with SessionLocal() as db:
            out["blobs_unlinked"], out["bytes_freed"] = await sweep_due(db)
    except Exception:  # noqa: BLE001
        logger.exception("storage maintenance: tombstone sweep failed")
    try:
        out["audit_pruned"], out["errors_pruned"] = await prune_logs()
    except Exception:  # noqa: BLE001
        logger.exception("storage maintenance: log retention failed")
    logger.info("storage maintenance: %s", out)
    return out


async def refresh_roster_texts() -> int:
    """Re-index every roster (each run re-renders its dated text)."""
    from sqlalchemy import select

    from app.chat.models import WorkspaceItem
    from app.workspaces.knowledge import index_roster_for_workspace

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(WorkspaceItem.workspace_id, WorkspaceItem.id).where(
                    WorkspaceItem.kind == "roster",
                    WorkspaceItem.trashed_at.is_(None),
                )
            )
        ).all()
    for wid, iid in rows:
        await index_roster_for_workspace(wid, iid)
    return len(rows)


async def prune_logs() -> tuple[int, int]:
    """Drop audit rows past AUDIT_RETENTION_DAYS and error rows past
    ERROR_LOG_RETENTION_DAYS — both grew forever (R-145)."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import delete

    from app.auth.events import AuthEvent
    from app.config import get_settings
    from app.observability.models import ErrorEvent

    settings = get_settings()
    now = datetime.now(timezone.utc)
    async with SessionLocal() as db:
        audit = await db.execute(
            delete(AuthEvent).where(AuthEvent.created_at < now - timedelta(days=settings.AUDIT_RETENTION_DAYS))
        )
        errors = await db.execute(
            delete(ErrorEvent).where(ErrorEvent.created_at < now - timedelta(days=settings.ERROR_LOG_RETENTION_DAYS))
        )
        await db.commit()
    return audit.rowcount or 0, errors.rowcount or 0


__all__ = ["run_storage_maintenance"]

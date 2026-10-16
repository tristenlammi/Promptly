"""Admin → Storage: the health of the bytes (WP-7.2, Part C §5.4).

    GET  /api/admin/storage/health                disk, checksums, hashes, problems, quarantine, runs
    POST /api/admin/storage/check                 run the scrubber now (in the background)
    POST /api/admin/storage/files/{id}/recheck    check one file again (after restoring it)
    POST /api/admin/storage/quarantine/empty      delete what the orphan walk set aside
    POST /api/admin/storage/media/retry           re-queue photos / videos the media worker failed on
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db
from app.files.models import StorageCheck, UserFile

router = APIRouter()


def _check_out(c: StorageCheck) -> dict[str, Any]:
    return {
        "id": str(c.id),
        "started_at": c.started_at.isoformat() if c.started_at else None,
        "finished_at": c.finished_at.isoformat() if c.finished_at else None,
        "status": c.status,
        "trigger": c.trigger,
        "checked": c.checked,
        "verified": c.verified,
        "bytes_verified": c.bytes_verified,
        "missing": c.missing,
        "damaged": c.damaged,
        "recovered": c.recovered,
        "quarantined": c.quarantined,
        "error": c.error,
    }


@router.get("/storage/health")
async def storage_health(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict[str, Any]:
    import asyncio

    from app.files import blobstore, disk_guard, scrubber

    du = disk_guard.usage()
    try:
        checksums = (await db.execute(text("SHOW data_checksums"))).scalar() == "on"
    except Exception:  # noqa: BLE001
        checksums = None
    canonical = text(blobstore.canonical_sql("files"))
    total, hashed, verified_30d = (
        await db.execute(
            select(
                func.count(UserFile.id),
                func.count(UserFile.content_sha256),
                func.count(UserFile.id).filter(UserFile.verified_at > func.now() - text("interval '30 days'")),
            ).where(canonical)
        )
    ).one()
    problems = (
        await db.execute(
            select(UserFile, User.username)
            .join(User, User.id == UserFile.user_id, isouter=True)
            .where(UserFile.blob_state.in_(("missing", "damaged")))
            .order_by(UserFile.blob_state, UserFile.filename)
            .limit(200)
        )
    ).all()
    n_problems = (
        await db.execute(select(func.count(UserFile.id)).where(UserFile.blob_state.in_(("missing", "damaged"))))
    ).scalar_one()
    runs = (await db.execute(select(StorageCheck).order_by(StorageCheck.started_at.desc()).limit(10))).scalars().all()
    quarantine = await asyncio.to_thread(scrubber.quarantine_summary)
    from app.files.media_pipeline import queue_status

    media = await queue_status(db)
    from app.photos import places
    from app.photos.understanding import progress

    return {
        "media": media,
        # Understanding photos (PH-2): every library, and the place names.
        "understanding": {"stages": await progress(db), "gazetteer": await places.status(db)},
        "disk": {
            "total": du.total, "used": du.used, "free": du.free, "min_free": du.min_free,
            "percent_used": du.percent_used, "uploads_paused": du.low,
        },
        "checksums": checksums,
        "files": {"canonical": total, "hashed": hashed, "unhashed": total - hashed, "verified_30d": verified_30d},
        "problems": [
            {
                "id": str(f.id), "filename": f.filename, "owner": username, "state": f.blob_state,
                "size_bytes": f.size_bytes, "verified_at": f.verified_at.isoformat() if f.verified_at else None,
                "storage_path": f.storage_path, "trashed": f.trashed_at is not None,
            }
            for f, username in problems
        ],
        "problem_count": n_problems,
        "quarantine": quarantine,
        "runs": [_check_out(c) for c in runs],
    }


@router.post("/storage/check", status_code=status.HTTP_202_ACCEPTED)
async def run_storage_check(_admin: User = Depends(require_admin)) -> dict[str, str]:
    """Start a check now — presence and size of every file, and as much
    re-hashing as the budget allows. Runs in the background."""
    from app.background import spawn
    from app.files.scrubber import run_check

    spawn(run_check(trigger="manual", orphans=False), name="storage_check_manual")
    return {"status": "started"}


@router.post("/storage/files/{file_id}/recheck")
async def recheck(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict[str, str]:
    from app.files.scrubber import recheck_file

    row = await db.get(UserFile, file_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return {"state": await recheck_file(db, row)}


@router.post("/storage/understanding/retry")
async def retry_understanding(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict[str, int]:
    """Try photos understanding gave up on again — and the place names, if
    they couldn't be downloaded."""
    from app.photos import places

    await places.reset_failure()
    n = (await db.execute(text("DELETE FROM photo_understanding WHERE state = 'failed'"))).rowcount or 0
    await db.commit()
    return {"retried": n}


@router.post("/storage/media/retry")
async def retry_media(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict[str, int]:
    """Try the photos and videos the media worker gave up on again."""
    from sqlalchemy import update

    from app.files.models import FileMedia
    from app.tasks.queue import enqueue_media

    ids = (
        await db.execute(
            update(FileMedia)
            .where(FileMedia.derivative_state == "failed")
            .values(derivative_state="pending", attempts=0)
            .returning(FileMedia.file_id)
        )
    ).scalars().all()
    await db.commit()
    for fid in ids:
        await enqueue_media(fid)
    return {"queued": len(ids)}


@router.post("/storage/quarantine/empty")
async def empty_quarantine(_admin: User = Depends(require_admin)) -> dict[str, int]:
    import asyncio

    from app.files.scrubber import empty_quarantine as _empty

    return {"deleted": await asyncio.to_thread(_empty)}


__all__ = ["router"]

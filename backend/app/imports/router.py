"""Imports (WP-10.1).

    GET    /api/imports                 your imports
    POST   /api/imports                 a new one ({"source": "takeout"})
    GET    /api/imports/{id}            its parts, state, report and progress
    DELETE /api/imports/{id}/parts/{n}  take a part out (before importing)
    POST   /api/imports/{id}/check      read the parts → the dry-run report
    DELETE /api/imports/{id}            cancel it and delete its parts

Parts are uploaded through tusd with ``import_job=<id>`` in the metadata
(``files.tus_hooks``).
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.imports import jobs
from app.imports.models import ImportJob

router = APIRouter()


class ImportCreate(BaseModel):
    source: Literal["takeout", "folder", "apple"] = "takeout"


def _out(job: ImportJob) -> dict[str, Any]:
    return {
        "id": str(job.id),
        "source": job.source,
        "state": job.state,
        "parts": [{"n": p["n"], "name": p["name"], "size": p["size"]} for p in (job.parts or [])],
        "report": job.report,
        "progress": job.progress,
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


async def _job(db: AsyncSession, job_id: uuid.UUID, user: User) -> ImportJob:
    job = await db.get(ImportJob, job_id)
    if job is None or job.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such import.")
    return job


@router.get("")
async def list_imports(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict[str, Any]]:
    rows = (
        await db.execute(select(ImportJob).where(ImportJob.user_id == user.id).order_by(ImportJob.created_at.desc()).limit(50))
    ).scalars().all()
    return [_out(j) for j in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_import(payload: ImportCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    job = ImportJob(user_id=user.id, source=payload.source, state="collecting", parts=[])
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return _out(job)


@router.get("/{job_id}")
async def get_import(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return _out(await _job(db, job_id, user))


@router.delete("/{job_id}/parts/{n}")
async def remove_part(
    job_id: uuid.UUID, n: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    job = await _job(db, job_id, user)
    if job.state not in ("collecting", "ready", "failed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The import has started.")
    keep, gone = [], None
    for p in job.parts or []:
        (gone := p) if p["n"] == n else keep.append(p)
    if gone is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such part.")
    await asyncio.to_thread((jobs.job_dir(job.id) / gone["file"]).unlink, True)
    job.parts, job.state, job.report, job.error = keep, "collecting", None, None
    await db.commit()
    await db.refresh(job)
    return _out(job)


@router.post("/{job_id}/check")
async def check_import(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    job = await _job(db, job_id, user)
    if job.state not in ("collecting", "ready", "failed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="It's already being read or imported.")
    if not job.parts:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Upload the archive parts first.")
    job.state, job.report, job.error = "indexing", None, None
    await db.commit()
    await jobs.enqueue_index(job.id)
    await db.refresh(job)
    return _out(job)


@router.post("/{job_id}/start")
async def start_import(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Import what the check found (WP-10.2). Starting a failed one again
    carries on: what's already in is recognised and not copied twice."""
    from app.imports.run import enqueue_run

    job = await _job(db, job_id, user)
    if job.state not in ("ready", "failed") or not job.report:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Check the archives first.")
    if not await asyncio.to_thread(jobs.plan_path(job.id).is_file):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Check the archives again first.")
    job.state, job.error = "importing", None
    await db.commit()
    await enqueue_run(job.id)
    await db.refresh(job)
    return _out(job)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_import(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    job = await _job(db, job_id, user)
    if job.state == "importing":
        # The run stops at its next photo and tidies up after itself.
        job.state = "cancelled"
        await db.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await asyncio.to_thread(jobs.remove_files, job.id)
    if job.state in ("done", "cancelled"):
        await db.delete(job)  # forget a finished one
    else:
        job.state, job.parts, job.finished_at = "cancelled", [], datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ tus


async def plan_part(db: AsyncSession, user: User, job_id: str, filename: str, size: int) -> None:
    """tusd's pre-create for an archive part: refuses what can't be one."""
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad import.") from None
    job = await _job(db, jid, user)
    if job.state not in ("collecting", "ready", "failed"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This import is already under way.")
    if jobs.part_ext(filename) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Upload the .zip or .tgz files Google Takeout gave you."
        )
    if len(job.parts or []) >= jobs.MAX_PARTS:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"An import takes up to {jobs.MAX_PARTS} parts.")


async def adopt_part(db: AsyncSession, user: User, job_id: str, filename: str, path) -> int:  # noqa: ANN001 — Path
    """tusd's pre-finish: the finished upload becomes the job's next part."""
    jid = uuid.UUID(job_id)
    job = await _job(db, jid, user)
    if job.state not in ("collecting", "ready", "failed"):
        # Cancelled (or under way) since this upload began — e.g. a resumed
        # upload still tagged with an import that was cancelled. The caller
        # deletes the file rather than leave it in a dead import.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That import was cancelled — add the part to a new one.")
    n = max((p["n"] for p in job.parts or []), default=0) + 1
    ext = jobs.part_ext(filename) or ".zip"
    dest_dir = jobs.job_dir(jid)
    await asyncio.to_thread(dest_dir.mkdir, parents=True, exist_ok=True)
    target = dest_dir / f"part-{n:03d}{ext}"
    await asyncio.to_thread(path.replace, target)
    job.parts = [*(job.parts or []), {"n": n, "name": filename[:200], "size": target.stat().st_size, "file": target.name}]
    if job.state in ("ready", "failed"):
        job.state, job.report, job.error = "collecting", None, None  # read it again with the new part
    await db.commit()
    return n


__all__ = ["adopt_part", "plan_part", "router"]

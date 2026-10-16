"""Meeting-notes endpoints (S-tier 4.4).

* ``POST /api/workspaces/{wid}/meetings`` — upload a recording; creates a
  :class:`MeetingJob` and enqueues the durable Arq pipeline (chunked
  Whisper transcription → model summary → seeded workspace note).
* ``GET  /api/workspaces/{wid}/meetings`` — recent jobs, newest first, so
  a re-opened modal can resume showing an in-flight job.
* ``GET  /api/workspaces/{wid}/meetings/{job_id}`` — poll one job.

The audio itself is transient input: it lands under ``uploads/meetings/``
for the worker to read and is deleted when the job reaches a terminal
state. The deliverable is the note.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.disk_guard import require_disk_room
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.tasks.queue import enqueue_meeting
from app.workspaces.meetings_models import MeetingJob
from app.workspaces.shares import get_accessible_workspace, require_workspace_write

logger = logging.getLogger("promptly.workspaces.meetings")

router = APIRouter()

# Matches nginx's client_max_body_size (100M) — the practical wall for a
# single upload. ~3 hours of 64 kbps m4a, ~1.5 hours of browser webm.
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# Containers we'll hand to ffmpeg. Video is allowed on purpose — a screen
# recording of a call is a common shape for "the meeting"; we extract the
# audio track and drop the rest.
_ALLOWED_EXTS = {
    ".webm", ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".wav",
    ".flac", ".mp4", ".mov", ".mka", ".mkv", ".wma", ".amr", ".3gp",
}


class MeetingJobResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str | None
    status: str
    progress_done: int
    progress_total: int
    duration_s: int | None
    error: str | None
    note_item_id: uuid.UUID | None
    created_at: datetime
    # A failed summary keeps the transcript: download it, or retry the
    # summary without transcribing again (R-133).
    has_transcript: bool = False

    model_config = {"from_attributes": True}

    @classmethod
    def of(cls, job: MeetingJob) -> "MeetingJobResponse":
        out = cls.model_validate(job)
        out.has_transcript = bool(job.transcript)
        return out


ACTIVE_STATES = ("pending", "transcribing", "summarising")


@router.post(
    "/{workspace_id}/meetings",
    response_model=MeetingJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_meeting_job(
    workspace_id: uuid.UUID,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    # Optional BCP-47 hint for Whisper; empty/auto → detect.
    language: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),  # WP-7.2
) -> MeetingJobResponse:
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="That doesn't look like an audio or video recording.",
        )

    # One at a time per workspace: transcription monopolises the (single
    # model) Whisper worker anyway, and it keeps the failure story simple.
    # A job a restart orphaned stops counting once it's older than any real
    # run could be (the reaper marks it failed soon after) — it used to
    # block new recordings in this workspace forever (R-240).
    from app.tasks.stale_run_reaper import MEETING_STALE_AFTER

    active = await db.scalar(
        select(MeetingJob.id).where(
            MeetingJob.workspace_id == ws.id,
            MeetingJob.status.in_(ACTIVE_STATES),
            MeetingJob.updated_at > datetime.now(timezone.utc) - MEETING_STALE_AFTER,
        )
    )
    if active is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A recording is already being processed for this "
            "workspace — wait for it to finish.",
        )

    # No model to summarise with means an hour of transcription for nothing
    # — say so before taking the upload (R-133).
    from app.workspaces.meetings_runner import MeetingError, resolve_summary_model

    try:
        await resolve_summary_model(db, ws)
    except MeetingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    job = MeetingJob(
        workspace_id=ws.id,
        user_id=user.id,
        title=(title or "").strip()[:200] or None,
        language=(language or "").strip()[:16] or None,
        status="pending",
    )
    db.add(job)
    await db.flush()

    from app.files.storage import copy_stream_to_disk_async, delete_blob

    rel = f"meetings/{job.id}{ext}"
    try:
        await copy_stream_to_disk_async(
            file.file, rel, size_limit=_MAX_UPLOAD_BYTES
        )
    except ValueError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Recordings are capped at "
            f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )
    except OSError:
        await db.rollback()
        logger.exception("meeting upload write failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Couldn't store the recording — try again.",
        )
    finally:
        await file.close()

    job.audio_path = rel
    try:
        await db.commit()
    except Exception:
        delete_blob(rel)
        raise
    await db.refresh(job)
    await enqueue_meeting(job.id)
    return MeetingJobResponse.of(job)


@router.get(
    "/{workspace_id}/meetings", response_model=list[MeetingJobResponse]
)
async def list_meeting_jobs(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MeetingJobResponse]:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    rows = (
        (
            await db.execute(
                select(MeetingJob)
                .where(MeetingJob.workspace_id == ws.id)
                .order_by(MeetingJob.created_at.desc())
                .limit(10)
            )
        )
        .scalars()
        .all()
    )
    return [MeetingJobResponse.of(r) for r in rows]


@router.get(
    "/{workspace_id}/meetings/{job_id}", response_model=MeetingJobResponse
)
async def get_meeting_job(
    workspace_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MeetingJobResponse:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    job = await db.get(MeetingJob, job_id)
    if job is None or job.workspace_id != ws.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return MeetingJobResponse.of(job)


@router.get("/{workspace_id}/meetings/{job_id}/transcript")
async def download_meeting_transcript(
    workspace_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The raw transcript as a text file — kept when the summary fails, so
    an hour of transcription isn't lost (R-133)."""
    from fastapi.responses import PlainTextResponse

    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    job = await db.get(MeetingJob, job_id)
    if job is None or job.workspace_id != ws.id or not job.transcript:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return PlainTextResponse(
        job.transcript,
        headers={
            "Content-Disposition": f'attachment; filename="transcript-{job.id}.txt"'
        },
    )


@router.post(
    "/{workspace_id}/meetings/{job_id}/retry", response_model=MeetingJobResponse
)
async def retry_meeting_summary(
    workspace_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MeetingJobResponse:
    """Summarise a failed job's saved transcript again (after setting a
    model, say) — without re-uploading or re-transcribing."""
    from app.chat.models import Workspace
    from app.workspaces.meetings_runner import MeetingError, resolve_summary_model

    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    job = await db.get(MeetingJob, job_id)
    if job is None or job.workspace_id != ws.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if job.status != "failed" or not job.transcript:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only a recording whose notes failed after transcription can be retried.",
        )
    try:
        await resolve_summary_model(db, await db.get(Workspace, ws.id))
    except MeetingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    job.status = "pending"
    job.error = None
    await db.commit()
    await db.refresh(job)
    await enqueue_meeting(job.id)
    return MeetingJobResponse.of(job)


@router.post(
    "/{workspace_id}/meetings/{job_id}/cancel", response_model=MeetingJobResponse
)
async def cancel_meeting_job(
    workspace_id: uuid.UUID,
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MeetingJobResponse:
    """Stop a recording that's still being processed. The uploader, or a
    workspace owner/admin, can cancel; the worker notices at its next step."""
    from app.files.storage import delete_blob
    from app.workspaces.shares import require_workspace_admin

    ws, role = await get_accessible_workspace(workspace_id, user, db)
    job = await db.get(MeetingJob, job_id)
    if job is None or job.workspace_id != ws.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if job.user_id != user.id:
        require_workspace_admin(role)
    if job.status not in ACTIVE_STATES:
        return MeetingJobResponse.of(job)
    job.status = "failed"
    job.error = "Cancelled."
    audio_rel, job.audio_path = job.audio_path, None
    await db.commit()
    await db.refresh(job)
    if audio_rel:
        delete_blob(audio_rel)
    return MeetingJobResponse.of(job)


__all__ = ["router"]

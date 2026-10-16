"""The PDF viewer's save (WP-6.5).

    GET /api/files/{id}/pdf    may this person edit it, and which bytes are current
    PUT /api/files/{id}/pdf    save an edited PDF — the current bytes become a version

Filling forms, annotating and page changes all happen in the browser; this
only takes the result. A save carries the ``revision`` the editor loaded
(the download's ``X-File-Revision``); one based on an older copy gets a 409
so it can't silently undo someone else's save.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.disk_guard import require_disk_room
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import UserFile

router = APIRouter()


class PdfInfo(BaseModel):
    can_edit: bool
    revision: str


class PdfSaved(BaseModel):
    revision: str
    size_bytes: int
    version_id: uuid.UUID
    modified_at: str


async def _pdf(db: AsyncSession, file_id: uuid.UUID, user: User) -> tuple[UserFile, str]:
    from app.files.pdf_edit import is_editable_pdf, pdf_access

    row = await db.get(UserFile, file_id)
    if row is None or not is_editable_pdf(row):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")
    access = await pdf_access(db, row, user)
    if access == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PDF not found")
    return row, access


@router.get("/{file_id:uuid}/pdf", response_model=PdfInfo)
async def pdf_info(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PdfInfo:
    from app.files.pdf_edit import revision

    row, access = await _pdf(db, file_id, user)
    return PdfInfo(can_edit=access == "edit", revision=revision(row))


@router.put("/{file_id:uuid}/pdf", response_model=PdfSaved)
async def save_pdf_route(
    file_id: uuid.UUID,
    file: UploadFile = File(...),
    revision: str = Form(..., max_length=64),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),  # WP-7.2
) -> PdfSaved:
    import asyncio

    from app.files.pdf_edit import PdfConflict, PdfEditError, revision as current_revision, save_pdf
    from app.files.storage import MAX_FILE_BYTES

    row, access = await _pdf(db, file_id, user)
    if access != "edit":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can view this PDF but not change it.")
    data = await asyncio.to_thread(file.file.read, MAX_FILE_BYTES + 1)
    try:
        version = await save_pdf(db, row, user, data, base=revision)
    except PdfConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except PdfEditError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return PdfSaved(
        revision=current_revision(row),
        size_bytes=row.size_bytes,
        version_id=version.id,
        modified_at=row.modified_at.isoformat(),
    )


__all__ = ["router"]

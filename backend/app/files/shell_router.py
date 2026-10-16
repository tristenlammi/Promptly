"""The Files shell's extra reads (WP-3.5, Part C §2.2).

* ``GET /api/files/workspaces/{id}`` — a workspace as a drive: its
  Documents, Sheets and Whiteboards and the files pinned to it, as Drive
  rows, honouring private drafts and the workspace's trash. Replaces
  browsing the System › Workspaces mirror folders.
* ``GET /api/files/{id}/details`` — the details pane: owner, location,
  created / modified, kind, and where it lives in a workspace.
* ``GET /api/files/storage`` — the storage meter's breakdown (files,
  trash, versions) and when your data was last backed up.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileFolder, FileVersion, UserFile
from app.files.schemas import FileResponse

router = APIRouter()


# --------------------------------------------------------------------
# Workspaces as drives
# --------------------------------------------------------------------
class WorkspaceDriveEntry(BaseModel):
    file: FileResponse
    # "note" / "sheet" / "canvas" for an item, "pinned" for a pinned file.
    item_kind: str
    item_id: uuid.UUID | None = None


class WorkspaceDriveListing(BaseModel):
    workspace_id: uuid.UUID
    title: str
    role: str
    entries: list[WorkspaceDriveEntry]


@router.get("/workspaces/{workspace_id:uuid}", response_model=WorkspaceDriveListing)
async def workspace_drive(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDriveListing:
    from app.chat.models import Spreadsheet, WorkspaceCanvas, WorkspaceFile, WorkspaceItem
    from app.files.router import _file_to_response
    from app.files.sharing import bulk_summaries
    from app.workspaces.shares import get_accessible_workspace

    ws, role = await get_accessible_workspace(workspace_id, user, db)
    items = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.workspace_id == ws.id,
                WorkspaceItem.kind.in_(("note", "sheet", "canvas")),
                WorkspaceItem.trashed_at.is_(None),
                WorkspaceItem.ref_id.is_not(None),
            )
        )
    ).scalars().all()
    # Someone else's private draft isn't theirs to see (Part C §3.3).
    items = [i for i in items if not (i.visibility == "private" and i.created_by != user.id)]

    file_ids: dict[uuid.UUID, tuple[str, uuid.UUID | None]] = {}
    sheet_refs = [i.ref_id for i in items if i.kind == "sheet"]
    canvas_refs = [i.ref_id for i in items if i.kind == "canvas"]
    shell_of: dict[uuid.UUID, uuid.UUID] = {}
    if sheet_refs:
        shell_of.update(
            dict((await db.execute(select(Spreadsheet.id, Spreadsheet.file_id).where(Spreadsheet.id.in_(sheet_refs)))).all())
        )
    if canvas_refs:
        shell_of.update(
            dict(
                (
                    await db.execute(
                        select(WorkspaceCanvas.id, WorkspaceCanvas.file_id).where(WorkspaceCanvas.id.in_(canvas_refs))
                    )
                ).all()
            )
        )
    for i in items:
        fid = i.ref_id if i.kind == "note" else shell_of.get(i.ref_id)
        if fid is not None:
            file_ids[fid] = (i.kind, i.id)
    for (fid,) in (
        await db.execute(select(WorkspaceFile.file_id).where(WorkspaceFile.workspace_id == ws.id))
    ).all():
        file_ids.setdefault(fid, ("pinned", None))

    rows = []
    if file_ids:
        rows = list(
            (
                await db.execute(
                    select(UserFile)
                    .where(UserFile.id.in_(list(file_ids)), UserFile.trashed_at.is_(None))
                    .order_by(UserFile.modified_at.desc().nullslast())
                )
            ).scalars()
        )
    summaries, _ = await bulk_summaries(db, files=rows, folders=[], caller=user)
    return WorkspaceDriveListing(
        workspace_id=ws.id,
        title=ws.title,
        role=role,
        entries=[
            WorkspaceDriveEntry(
                file=_file_to_response(r, caller=user, sharing=summaries.get(r.id)),
                item_kind=file_ids[r.id][0],
                item_id=file_ids[r.id][1],
            )
            for r in rows
        ],
    )


# --------------------------------------------------------------------
# Details pane
# --------------------------------------------------------------------
class FileDetails(BaseModel):
    id: uuid.UUID
    owner_id: uuid.UUID | None
    owner_name: str | None
    is_owner: bool
    # "My files / Taxes / 2026", "Shared with you", or the workspace.
    location: str
    folder_id: uuid.UUID | None
    workspace_id: uuid.UUID | None = None
    workspace_title: str | None = None
    created_at: datetime
    modified_at: datetime | None
    size_bytes: int
    versions: int = 0


@router.get("/{file_id:uuid}/details", response_model=FileDetails)
async def file_details(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileDetails:
    from app.files.router import _can_still_open, _folder_path, _owning_workspace, _workspace_roots

    row = await db.get(UserFile, file_id)
    if row is None or (row.user_id != user.id and not await _can_still_open(db, row, user)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    owner = await db.get(User, row.user_id) if row.user_id else None
    ws = await _owning_workspace(db, row.folder_id, await _workspace_roots(db)) if row.folder_id else None
    if ws is not None:
        location = f"Workspace · {ws[1]}"
    elif row.user_id == user.id:
        folder = await db.get(FileFolder, row.folder_id) if row.folder_id else None
        location = await _folder_path(db, folder)
    else:
        location = "Shared with you"
    versions = await db.scalar(select(func.count()).select_from(FileVersion).where(FileVersion.file_id == row.id))
    return FileDetails(
        id=row.id,
        owner_id=row.user_id,
        owner_name=owner.username if owner is not None else None,
        is_owner=row.user_id == user.id,
        location=location,
        folder_id=row.folder_id if row.user_id == user.id else None,
        workspace_id=ws[0] if ws else None,
        workspace_title=ws[1] if ws else None,
        created_at=row.created_at,
        modified_at=row.modified_at,
        size_bytes=row.size_bytes,
        versions=int(versions or 0),
    )


# --------------------------------------------------------------------
# Storage meter + protection badge
# --------------------------------------------------------------------
class StorageBreakdown(BaseModel):
    cap_bytes: int | None
    used_bytes: int
    # What makes up ``used_bytes``: live files and what's in the trash.
    files_bytes: int
    trash_bytes: int
    # Sheets and whiteboards not yet counted (until
    # ``app_settings.office_quota_from``, WP-3.2).
    office_pending_bytes: int = 0
    # Earlier versions of documents, sheets and whiteboards — counted in
    # ``used_bytes`` from ``versions_counted_from`` (WP-6.2), free before.
    versions_bytes: int
    versions_counted: bool = False
    versions_counted_from: datetime | None = None
    # The newest successful backup of the server (database + files), and
    # of its off-site copy when one is set up.
    last_backup_at: datetime | None
    last_offsite_at: datetime | None


@router.get("/storage", response_model=StorageBreakdown)
async def storage_breakdown(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StorageBreakdown:
    from sqlalchemy import or_

    from app.backups.models import BackupRun
    from app.files.generated_kinds import HIDDEN_KINDS, GeneratedKind
    from app.files.quota import get_quota

    quota = await get_quota(db, user)
    derived = sorted(HIDDEN_KINDS - {GeneratedKind.DOCUMENT_ASSET.value})
    trash = await db.scalar(
        select(func.coalesce(func.sum(UserFile.size_bytes), 0)).where(
            UserFile.user_id == user.id,
            UserFile.trashed_at.is_not(None),
            or_(UserFile.source_kind.is_(None), UserFile.source_kind.not_in(derived)),
        )
    )

    async def last_ok(kinds: tuple[str, ...]) -> datetime | None:
        return await db.scalar(
            select(func.max(BackupRun.finished_at)).where(BackupRun.status == "ok", BackupRun.kind.in_(kinds))
        )

    trash_b = min(int(trash or 0), quota.used_bytes)
    counted_versions = quota.versions_bytes if quota.versions_counted else 0
    return StorageBreakdown(
        cap_bytes=quota.cap_bytes,
        used_bytes=quota.used_bytes,
        files_bytes=max(quota.used_bytes - trash_b - counted_versions, 0),
        trash_bytes=trash_b,
        office_pending_bytes=quota.office_pending_bytes,
        versions_bytes=quota.versions_bytes,
        versions_counted=quota.versions_counted,
        versions_counted_from=quota.versions_from,
        last_backup_at=await last_ok(("nightly", "pre_migrate", "manual")),
        last_offsite_at=await last_ok(("offsite",)),
    )


__all__ = ["router"]


# --------------------------------------------------------------------
# A file's extracted text — the outline preview for PowerPoint / Excel /
# OpenDocument uploads (WP-4.3).
# --------------------------------------------------------------------
class FileText(BaseModel):
    text: str | None
    # True while the worker hasn't read an Office file yet.
    pending: bool = False
    # A faithful PDF of it (the optional converter, Stage 12): asking starts
    # one. None when the server doesn't make them, or not for this file.
    preview: Literal["ready", "pending", "failed"] | None = None


@router.get("/{file_id:uuid}/text", response_model=FileText)
async def file_text(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileText:
    from app.files.office_formats import office_ext
    from app.files.router import _can_still_open

    row = await db.get(UserFile, file_id)
    if row is None or (row.user_id != user.id and not await _can_still_open(db, row, user)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    from app.files import convert

    text = row.content_text
    preview = await convert.request(row) if row.trashed_at is None else None
    return FileText(
        text=(text or None) and text[:200_000], pending=text is None and office_ext(row.filename) is not None,
        preview=preview,
    )


@router.get("/{file_id:uuid}/office-preview")
async def office_preview(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):  # noqa: ANN201 — a FileResponse
    """The PDF the converter made of an Office file (Stage 12) — for whoever
    can open the file; 404 until it's made (or with the converter off)."""
    import asyncio

    from fastapi.responses import FileResponse

    from app.files import convert
    from app.files.router import _can_still_open

    row = await db.get(UserFile, file_id)
    if row is None or (row.user_id != user.id and not await _can_still_open(db, row, user)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not convert.enabled() or not await asyncio.to_thread(convert.ready, row):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No preview yet")
    return FileResponse(
        str(convert.pdf_path(row.id)), media_type="application/pdf",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Disposition": "inline"},
    )


@router.get("/{file_id:uuid}/sheet-preview")
async def file_sheet_preview(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """An uploaded .xlsx / .ods / .csv as Fortune tabs (the top-left 200 ×
    50 of each), for the preview grid (WP-4.4). Converted on demand."""
    import os

    from starlette.concurrency import run_in_threadpool

    from app.files.router import _can_still_open
    from app.files.storage import absolute_path
    from app.workspaces.sheet_io import SPREADSHEET_EXTS, SheetImportError, import_spreadsheet, preview_tabs

    row = await db.get(UserFile, file_id)
    if row is None or row.trashed_at is not None or (
        row.user_id != user.id and not await _can_still_open(db, row, user)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if os.path.splitext(row.filename or "")[1].lower() not in SPREADSHEET_EXTS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Not a spreadsheet")
    if (row.size_bytes or 0) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="This spreadsheet is too big to preview."
        )
    path = absolute_path(row.storage_path)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File data missing on disk")
    try:
        tabs, notes = await run_in_threadpool(import_spreadsheet, path.read_bytes(), row.filename or "")
    except SheetImportError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    shown, truncated = preview_tabs(tabs)
    return {"tabs": shown, "truncated": truncated, "notes": notes}


# ------------------------------------------------------------------
# Ask your Drive — settings + status (WP-5.1)
# ------------------------------------------------------------------
class DriveAiSettings(BaseModel):
    enabled: bool
    excluded_folder_ids: list[uuid.UUID] = []
    # How chats use it (WP-5.2); left out = unchanged.
    chat_mode: Literal["auto", "always", "off"] | None = None


async def _drive_ai_view(db: AsyncSession, user: User) -> dict:
    from app.files.drive_index import status_for

    out = await status_for(db, user)
    folders = []
    for fid in out["excluded_folder_ids"]:
        try:
            folder = await db.get(FileFolder, uuid.UUID(fid))
        except ValueError:
            continue
        if folder is not None and folder.user_id == user.id:
            folders.append({"id": str(folder.id), "name": folder.name})
    out["excluded_folders"] = folders
    return out


@router.get("/ai-index")
async def get_drive_ai(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Whether AI search covers your Drive, what's left out, and progress."""
    return await _drive_ai_view(db, user)


@router.put("/ai-index")
async def put_drive_ai(
    body: DriveAiSettings,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Turn AI search of your Drive on or off (off removes its index of your
    files), and choose folders to leave out (only your own folders)."""
    from app.files.drive_index import save_drive_settings

    own = []
    for fid in body.excluded_folder_ids:
        folder = await db.get(FileFolder, fid)
        if folder is None or folder.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
        own.append(str(fid))
    await save_drive_settings(db, user, enabled=body.enabled, excluded_folder_ids=own, chat_mode=body.chat_mode)
    await db.commit()
    return await _drive_ai_view(db, user)


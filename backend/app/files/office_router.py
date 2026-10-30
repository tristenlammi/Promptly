"""One collab-token endpoint for every office file (WP-3.2, Part C §3.3).

``POST /api/files/{file_id}/collab-token`` answers for a Document, a Sheet
or a Whiteboard alike: it resolves access with
:func:`app.files.office.get_office_access` (ownership, Drive grants, the
workspace role, private drafts, trash) and mints the room's token. The
three old endpoints (``/api/documents/{id}/collab-token``,
``/api/canvas/{id}/collab-token``, the workspace sheet one) delegate here,
so a grant now opens a sheet or whiteboard as it already opened a doc.
Room names are unchanged: the bare document id, ``sheet:<id>``,
``canvas:<id>``.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.files.office import content_for_shell, get_office_access
from app.files.schemas import CollabTokenResponse, CollabTokenUser

router = APIRouter()


async def office_token_response(db: AsyncSession, row: UserFile, user: User) -> CollabTokenResponse:
    """Mint the collab token for ``row``; 404 when the caller has no access."""
    access = await get_office_access(db, row, user)
    if access == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    from app.files.documents_router import _color_for_user

    perm = "write" if access == "edit" else "read"
    kind = row.source_kind
    if kind == GeneratedKind.DOCUMENT.value:
        from app.files.documents_router import _mint_collab_token

        token, exp = _mint_collab_token(document_id=row.id, user=user, perm=perm, epoch=row.collab_epoch or 0)
        room = str(row.id)
    else:
        entity = await content_for_shell(db, row)
        if entity is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        if kind == GeneratedKind.SHEET.value:
            from app.workspaces.items_router import _mint_sheet_token

            token, exp = _mint_sheet_token(sheet_id=entity.id, user=user, perm=perm, epoch=row.collab_epoch or 0)
            room = f"sheet:{entity.id}"
        else:
            from app.workspaces.canvas_router import _mint_canvas_token

            token, exp = _mint_canvas_token(canvas_id=entity.id, user=user, perm=perm, epoch=row.collab_epoch or 0)
            room = f"canvas:{entity.id}"
    return CollabTokenResponse(
        token=token,
        expires_at=exp,
        can_edit=perm == "write",
        room=room,
        kind=kind,
        epoch=row.collab_epoch or 0,
        user=CollabTokenUser(
            id=user.id,
            name=user.username,
            color=user.avatar_color or _color_for_user(user.id),
            avatar=user.avatar_url,
        ),
    )


@router.post("/{file_id:uuid}/collab-token", response_model=CollabTokenResponse)
async def collab_token(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CollabTokenResponse:
    row = await db.get(UserFile, file_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return await office_token_response(db, row, user)


@router.get("/{file_id:uuid}/office")
async def office_info(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Where an office file opens and what the caller may do with it:
    ``{kind, access, workspace_id, item_id, content_id, path, file}`` — the
    editor page (``/files/doc|sheet|whiteboard/<id>``) builds its header
    from this. Opening records "opened" for Recent."""
    from sqlalchemy import select

    from app.chat.models import WorkspaceItem
    from app.files.office import is_shell

    row = await db.get(UserFile, file_id)
    if row is None or not (is_shell(row) or row.source_kind == GeneratedKind.DOCUMENT.value):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    access = await get_office_access(db, row, user)
    if access == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    workspace_id = item_id = None
    entity = await content_for_shell(db, row) if is_shell(row) else None
    if entity is not None and entity.workspace_id is not None:
        item_kind = "sheet" if row.source_kind == GeneratedKind.SHEET.value else "canvas"
        item = (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.ref_id == entity.id, WorkspaceItem.kind == item_kind
                )
            )
        ).scalars().first()
        workspace_id = entity.workspace_id
        item_id = item.id if item is not None else None
    # The editor page's header: breadcrumb, name, star, owner (WP-3.4).
    from app.files.activity import record_activity
    from app.files.models import FileFolder

    crumbs: list[dict] = []
    if row.user_id == user.id:
        cur = await db.get(FileFolder, row.folder_id) if row.folder_id else None
        for _ in range(64):
            if cur is None:
                break
            crumbs.append({"id": str(cur.id), "name": cur.name})
            cur = await db.get(FileFolder, cur.parent_id) if cur.parent_id else None
        crumbs.reverse()
    workspace_title = None
    if workspace_id is not None:
        from app.chat.models import Workspace

        ws = await db.get(Workspace, workspace_id)
        workspace_title = ws.title if ws is not None else None
    await record_activity(db, user_id=user.id, file_id=row.id, kind="opened")
    await db.commit()
    return {
        "kind": row.source_kind,
        "access": access,
        "workspace_id": str(workspace_id) if workspace_id else None,
        "workspace_title": workspace_title,
        "item_id": str(item_id) if item_id else None,
        "content_id": str(entity.id) if entity is not None else None,
        "is_owner": row.user_id == user.id,
        "path": crumbs,
        "file": (await _file_response(db, row, user)).model_dump(mode="json"),
    }


class _SnapshotRequest(BaseModel):
    source: Literal["pre_ai", "manual"] = "manual"
    label: str | None = Field(default=None, max_length=200)


@router.post("/{file_id:uuid}/versions", status_code=status.HTTP_201_CREATED)
async def take_snapshot(
    file_id: uuid.UUID,
    payload: _SnapshotRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Keep the file's current state as a version — editors call this with
    ``pre_ai`` just before applying an AI change (WP-3.3). Needs edit
    access. ``{"id": null}`` when there was nothing new to keep."""
    from app.files.versions import snapshot_file

    row = await db.get(UserFile, file_id)
    if row is None or await get_office_access(db, row, user) != "edit":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    from app import collab_internal
    from app.files.versions import RestoreError, room_for

    # The live room, when open, is newer than what's stored (WP-6.2).
    try:
        live = await collab_internal.live_state(await room_for(db, row))
    except RestoreError:
        live = None
    v = await snapshot_file(
        db, row, source=payload.source, label=payload.label, author_id=user.id, live_state=live
    )
    await db.commit()
    return {"id": str(v.id) if v is not None else None}


# =====================================================================
# WP-3.4 — personal office files: create, open, templates, sheet routes
# =====================================================================
from fastapi import BackgroundTasks, File, Query, UploadFile  # noqa: E402
from fastapi.responses import Response  # noqa: E402

from app.files.schemas import FileResponse as FileResponseSchema  # noqa: E402
from app.workspaces.schemas import SpreadsheetResponse, SpreadsheetSaveRequest  # noqa: E402

_EDITOR_PATHS = {
    GeneratedKind.DOCUMENT.value: "doc",
    GeneratedKind.SHEET.value: "sheet",
    GeneratedKind.WHITEBOARD.value: "whiteboard",
}


def editor_path(row: UserFile) -> str | None:
    """Where an office file opens in the app (``/files/doc/<id>`` …)."""
    seg = _EDITOR_PATHS.get(row.source_kind or "")
    return f"/files/{seg}/{row.id}" if seg else None


async def _file_response(db: AsyncSession, row: UserFile, user: User) -> FileResponseSchema:
    from app.files.router import _file_to_response

    return _file_to_response(row, caller=user)


async def _target_folder(db: AsyncSession, folder_id: uuid.UUID | None, user: User):
    """Validate where a new personal office file goes: a folder the caller
    owns, outside every workspace's folders (those are made in the
    workspace, which also adds them to its navigator)."""
    from app.files.router import _load_writable_folder, _owning_workspace, _workspace_conflict, _workspace_roots

    if folder_id is None:
        return None
    folder = await _load_writable_folder(db, folder_id, user)
    owner = await _owning_workspace(db, folder.id, await _workspace_roots(db))
    if owner is not None:
        raise _workspace_conflict(owner[1])
    return folder


class _CreateOfficeRequest(BaseModel):
    # "note" is a Document under another name (a workspace note is one too)
    # — it just starts as "Untitled note", so New → Note in Files reads right.
    kind: Literal["document", "note", "sheet", "whiteboard"] | None = None
    title: str | None = Field(default=None, max_length=200)
    folder_id: uuid.UUID | None = None
    # Start from this template (any office file the caller can read).
    template_id: uuid.UUID | None = None


@router.post("/office", response_model=FileResponseSchema, status_code=status.HTTP_201_CREATED)
async def create_office(
    payload: _CreateOfficeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponseSchema:
    """New Document / Spreadsheet / Whiteboard in the caller's Drive, blank
    or from a template (Part C §3.5)."""
    from app.files.office import create_office_file
    from app.files.office_templates import (
        copy_office_file,
        fill_template_placeholders,
        office_kind_of,
        office_title,
    )
    from app.files.quota import get_quota

    folder = await _target_folder(db, payload.folder_id, user)
    title = (payload.title or "").strip()
    if payload.template_id is not None:
        src = await db.get(UserFile, payload.template_id)
        if src is None or office_kind_of(src) is None or await get_office_access(db, src, user) == "none":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
        if not (await get_quota(db, user)).can_fit(src.size_bytes or 0):
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="This would exceed your storage quota.",
            )
        row = await copy_office_file(
            db, src, owner=user, folder_id=folder.id if folder else None, title=title or office_title(src)
        )
        if row.source_kind == GeneratedKind.SHEET.value:
            import json as _json

            sheet = await content_for_shell(db, row)
            if sheet is not None and sheet.data is not None:
                sheet.data = _json.loads(fill_template_placeholders(_json.dumps(sheet.data)))
    else:
        if payload.kind is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Pick a kind or a template."
            )
        default = {
            "document": "Untitled document",
            "note": "Untitled note",
            "sheet": "Untitled spreadsheet",
            "whiteboard": "Untitled whiteboard",
        }
        kind = "document" if payload.kind == "note" else payload.kind
        row, _entity = await create_office_file(
            db, kind=kind, owner=user, title=title or default[payload.kind],
            folder_id=folder.id if folder else None,
        )
    await db.commit()
    await db.refresh(row)
    return await _file_response(db, row, user)


class _ImportSheetRequest(BaseModel):
    source_file_id: uuid.UUID
    name: str | None = Field(default=None, max_length=200)


@router.post("/office/import-sheet", status_code=status.HTTP_201_CREATED)
async def import_sheet(
    payload: _ImportSheetRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """A new Promptly sheet made from an .xlsx / .xlsm / .ods / .csv the
    caller can open (WP-4.4, Part C §3.7). It goes next to the original when
    that's in the caller's own folder (otherwise My files), linked by
    ``source_file_id``; the original is never changed. Returns the new
    file, its editor path and ``notes`` on what didn't come across."""
    import os

    from starlette.concurrency import run_in_threadpool

    from app.files.office import create_office_file
    from app.files.quota import get_quota
    from app.files.router import _in_workspace_tree, _load_readable_file, _workspace_roots
    from app.files.storage import absolute_path
    from app.workspaces.sheet_io import SPREADSHEET_EXTS, SheetImportError, flatten_text, import_spreadsheet

    src = await _load_readable_file(db, payload.source_file_id, user)
    ext = os.path.splitext(src.filename or "")[1].lower()
    if src.trashed_at is not None or ext not in SPREADSHEET_EXTS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only an Excel (.xlsx), OpenDocument (.ods) or CSV file can be opened as a sheet.",
        )
    if (src.size_bytes or 0) > 25 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Files are capped at 25 MB.")
    path = absolute_path(src.storage_path)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File data missing on disk")
    raw = path.read_bytes()
    try:
        data, notes = await run_in_threadpool(import_spreadsheet, raw, src.filename or "")
    except SheetImportError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    if not (await get_quota(db, user)).can_fit(len(raw)):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="This would exceed your storage quota."
        )
    folder_id = None
    if src.user_id == user.id and src.folder_id is not None:
        if not await _in_workspace_tree(db, src.folder_id, await _workspace_roots(db)):
            folder_id = src.folder_id
    title = (payload.name or "").strip() or os.path.splitext(src.filename or "")[0] or "Imported sheet"
    row, _sheet = await create_office_file(
        db, kind="sheet", owner=user, title=title, folder_id=folder_id,
        data=data, content_text=flatten_text(data),
    )
    row.source_file_id = src.id
    await db.commit()
    await db.refresh(row)
    return {
        "file": (await _file_response(db, row, user)).model_dump(mode="json"),
        "path": f"/files/sheet/{row.id}",
        "notes": notes,
    }


@router.get("/templates")
async def get_templates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The caller's templates (the Templates folder, made with the starter
    set the first time)."""
    from app.files.office_templates import list_templates, office_kind_of, office_title, templates_folder

    rows = await list_templates(db, user)
    folder = await templates_folder(db, user)
    await db.commit()
    return {
        "folder_id": str(folder.id),
        "templates": [
            {"id": str(r.id), "kind": office_kind_of(r), "title": office_title(r), "modified_at": r.modified_at}
            for r in rows
        ],
    }


@router.post("/{file_id:uuid}/save-as-template", response_model=FileResponseSchema, status_code=status.HTTP_201_CREATED)
async def save_as_template(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponseSchema:
    """Copy an office file into the caller's Templates folder."""
    from app.files.office_templates import copy_office_file, office_kind_of, office_title, templates_folder

    src = await db.get(UserFile, file_id)
    if src is None or office_kind_of(src) is None or await get_office_access(db, src, user) == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    folder = await templates_folder(db, user)
    row = await copy_office_file(db, src, owner=user, folder_id=folder.id, title=office_title(src))
    await db.commit()
    await db.refresh(row)
    return await _file_response(db, row, user)


# --------------------------------------------------------------------
# File-scoped spreadsheet routes — the same editor API as the workspace
# ones (``/api/workspaces/{ws}/spreadsheets/{id}``), answered by file id
# and office access, so a personal or shared sheet opens on its own page.
# --------------------------------------------------------------------
async def _sheet_for(db: AsyncSession, file_id: uuid.UUID, user: User, *, edit: bool = False):
    row = await db.get(UserFile, file_id)
    if row is None or row.source_kind != GeneratedKind.SHEET.value:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    access = await get_office_access(db, row, user)
    if access == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if edit and access != "edit":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only view this sheet.")
    sheet = await content_for_shell(db, row)
    if sheet is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return row, sheet


@router.get("/{file_id:uuid}/sheet", response_model=SpreadsheetResponse)
async def file_get_sheet(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SpreadsheetResponse:
    _row, sheet = await _sheet_for(db, file_id, user)
    await _name_tabs(db, sheet)
    return SpreadsheetResponse.model_validate(sheet)


async def _name_tabs(db: AsyncSession, sheet) -> None:
    """Tabs without an id get one, saved, before anyone opens them — they're
    shared live by id (WP-6.3)."""
    import copy

    from sqlalchemy.orm.attributes import flag_modified

    from app.workspaces.sheet_io import ensure_tab_ids

    if sheet.data is None:
        return
    data = copy.deepcopy(sheet.data)
    if ensure_tab_ids(data):
        sheet.data = data
        flag_modified(sheet, "data")
        await db.commit()
        await db.refresh(sheet)


@router.put("/{file_id:uuid}/sheet", response_model=SpreadsheetResponse)
async def file_save_sheet(
    file_id: uuid.UUID,
    payload: SpreadsheetSaveRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SpreadsheetResponse:
    from app.files.activity import record_activity
    from app.workspaces.items_router import apply_sheet_save

    row, sheet = await _sheet_for(db, file_id, user, edit=True)
    await record_activity(db, user_id=user.id, file_id=row.id, kind="edited")
    await apply_sheet_save(db, sheet, payload, user, background)
    return SpreadsheetResponse.model_validate(sheet)


@router.post("/{file_id:uuid}/sheet/import")
async def file_import_sheet(
    file_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from app.workspaces.items_router import sheet_import_data

    _row, sheet = await _sheet_for(db, file_id, user, edit=True)
    return await sheet_import_data(db, sheet, file, user)


@router.get("/{file_id:uuid}/sheet/export")
async def file_export_sheet(
    file_id: uuid.UUID,
    format: str = Query("xlsx", pattern="^(xlsx|csv)$"),
    tab: int = Query(0, ge=0, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    from app.workspaces.items_router import sheet_export_response

    _row, sheet = await _sheet_for(db, file_id, user)
    return await sheet_export_response(sheet, format, tab)


@router.get("/{file_id:uuid}/sheet/versions")
async def file_sheet_versions(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.workspaces.items_router import sheet_version_rows

    _row, sheet = await _sheet_for(db, file_id, user)
    return await sheet_version_rows(db, sheet)


@router.get("/{file_id:uuid}/sheet/versions/{version_id:uuid}")
async def file_sheet_version(
    file_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from app.chat.models import SpreadsheetVersion

    _row, sheet = await _sheet_for(db, file_id, user)
    v = await db.get(SpreadsheetVersion, version_id)
    if v is None or v.spreadsheet_id != sheet.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return {"data": v.data}


@router.post("/{file_id:uuid}/sheet/versions/checkpoint")
async def file_sheet_checkpoint(
    file_id: uuid.UUID,
    reason: str = "restore",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from app.workspaces.items_router import snapshot_spreadsheet

    _row, sheet = await _sheet_for(db, file_id, user, edit=True)
    made = await snapshot_spreadsheet(
        db, sheet, user, reason=reason if reason in ("restore", "clear") else "restore"
    )
    await db.commit()
    return {"saved": made}


# --------------------------------------------------------------------
# Whiteboard thumbnails — the editor pushes a small PNG of the board
# --------------------------------------------------------------------
_MAX_THUMB_UPLOAD = 1024 * 1024


def whiteboard_thumb_path(file_id: uuid.UUID):
    from app.files import storage

    return storage.UPLOAD_ROOT / "derived" / "thumbs" / f"{file_id}-wb.png"


def _normalise_thumb(data: bytes) -> bytes:
    """Re-encode (never store what was sent) at most 320 px wide."""
    import io

    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        if im.format != "PNG":
            raise ValueError("not a PNG")
        im.thumbnail((320, 320))
        out = io.BytesIO()
        im.convert("RGBA").save(out, format="PNG", optimize=True)
        return out.getvalue()


@router.put("/{file_id:uuid}/thumbnail", status_code=status.HTTP_204_NO_CONTENT)
async def put_whiteboard_thumbnail(
    file_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    import asyncio

    row = await db.get(UserFile, file_id)
    if (
        row is None
        or row.source_kind != GeneratedKind.WHITEBOARD.value
        or await get_office_access(db, row, user) != "edit"
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    data = await file.read(_MAX_THUMB_UPLOAD + 1)
    if len(data) > _MAX_THUMB_UPLOAD:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Thumbnail too large")
    try:
        png = await asyncio.to_thread(_normalise_thumb, data)
    except Exception:  # noqa: BLE001 — anything Pillow can't read
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Not a PNG image")
    path = whiteboard_thumb_path(row.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(png)
    tmp.replace(path)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

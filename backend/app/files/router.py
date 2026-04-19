"""File uploads router.

Two pools live side-by-side:

* **mine** — rows where `user_id == caller.id`. Fully read/write for the
  caller, invisible to every other user.
* **shared** — rows where `user_id IS NULL`. Readable by every authenticated
  user; writable only by admins.

The shape of the public API (`/browse`, `/folders`, `/{file_id}`, etc.) is
the same for both pools — the scope is expressed as a `scope=mine|shared`
query parameter.

Phase 3 hardening (added on top of the original ACL model):

* Every upload is sanitised → magic-byte sniffed → EXIF-stripped → counted
  against a per-user storage cap before it lands in the DB.
* Every download forces ``Content-Disposition: attachment`` and a
  conservative ``Content-Type``, so a malicious shared blob can never be
  rendered inline by the browser.
"""
from __future__ import annotations

import logging
import os
import urllib.parse
import uuid
from typing import Any, Iterable

from fastapi import (
    APIRouter,
    Depends,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse as FastAPIFileResponse
from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import (
    EVENT_FILE_UPLOAD_REJECTED,
    EVENT_GENERATED_RERENDER_FAILED,
    EVENT_GENERATED_SOURCE_EDITED,
    record_event,
    safe_dict,
)
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileFolder, UserFile
from app.files.quota import StorageQuota, get_quota
from app.files.safety import (
    UnsafeUploadError,
    canonical_mime_for,
    sanitize_filename,
    sniff_and_validate,
    strip_image_metadata_in_place,
)
from app.files.generated import (
    GeneratedFileError,
    overwrite_generated_file,
)
from app.files.generated_kinds import GeneratedKind
from app.files.schemas import (
    BreadcrumbEntry,
    BrowseResponse,
    FileResponse,
    FileUpdateRequest,
    FolderCreateRequest,
    FolderResponse,
    FolderUpdateRequest,
    Scope,
    SourceContentResponse,
    SourceUpdateRequest,
    StorageQuotaResponse,
)
from app.files.system_folders import (
    folder_for_chat_upload,
    folder_for_generated,
)
from app.files.storage import (
    MAX_FILE_BYTES,
    absolute_path,
    copy_stream_to_disk,
    delete_blob,
    ensure_bucket,
    storage_path_for,
)

logger = logging.getLogger("promptly.files")

router = APIRouter()


# --------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------
def _scope_of(owner_id: uuid.UUID | None) -> Scope:
    return "shared" if owner_id is None else "mine"


def _owner_for_scope(user: User, scope: Scope) -> uuid.UUID | None:
    """Return the `user_id` value we should stamp on a new row in `scope`.

    Non-admins attempting to write into the shared pool get a 403 here —
    read access is granted everywhere else but writes are admin-only.
    """
    if scope == "shared":
        if user.role != "admin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only admins can modify the shared pool",
            )
        return None
    return user.id


def _folder_to_response(folder: FileFolder) -> FolderResponse:
    return FolderResponse(
        id=folder.id,
        parent_id=folder.parent_id,
        name=folder.name,
        scope=_scope_of(folder.user_id),
        created_at=folder.created_at,
        system_kind=folder.system_kind,
    )


def _assert_not_system_folder(folder: FileFolder, action: str) -> None:
    """Refuse mutations against folders the auto-routing relies on.

    System folders are still drop targets — files and other folders can
    move *into* them — but the folders themselves cannot be renamed,
    deleted, or moved out of their pinned location.
    """
    if folder.system_kind is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Can't {action} the {folder.name!r} system folder",
        )


def _file_to_response(f: UserFile) -> FileResponse:
    return FileResponse(
        id=f.id,
        folder_id=f.folder_id,
        filename=f.filename,
        mime_type=f.mime_type,
        size_bytes=f.size_bytes,
        scope=_scope_of(f.user_id),
        created_at=f.created_at,
    )


async def _load_readable_folder(
    db: AsyncSession, folder_id: uuid.UUID, user: User
) -> FileFolder:
    folder = await db.get(FileFolder, folder_id)
    if folder is None or not _can_read(folder.user_id, user):
        # Don't leak the existence of folders in other users' pools.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )
    return folder


async def _load_writable_folder(
    db: AsyncSession, folder_id: uuid.UUID, user: User
) -> FileFolder:
    folder = await _load_readable_folder(db, folder_id, user)
    if not _can_write(folder.user_id, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have write access to this folder",
        )
    return folder


async def _load_readable_file(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> UserFile:
    row = await db.get(UserFile, file_id)
    if row is None or not _can_read(row.user_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )
    return row


async def _load_writable_file(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> UserFile:
    row = await _load_readable_file(db, file_id, user)
    if not _can_write(row.user_id, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have write access to this file",
        )
    return row


def _can_read(owner_id: uuid.UUID | None, user: User) -> bool:
    # Shared pool is readable by everyone; private pools only by their owner.
    return owner_id is None or owner_id == user.id


def _can_write(owner_id: uuid.UUID | None, user: User) -> bool:
    if owner_id is None:
        return user.role == "admin"
    return owner_id == user.id


def _owner_filter(scope: Scope, user: User):
    if scope == "shared":
        return FileFolder.user_id.is_(None)
    return FileFolder.user_id == user.id


def _file_owner_filter(scope: Scope, user: User):
    if scope == "shared":
        return UserFile.user_id.is_(None)
    return UserFile.user_id == user.id


async def _build_breadcrumbs(
    db: AsyncSession, folder: FileFolder | None
) -> list[BreadcrumbEntry]:
    """Walk up the parent chain to produce a breadcrumb trail."""
    trail: list[BreadcrumbEntry] = []
    cursor = folder
    # Bound the walk so a cycle (shouldn't happen, but defensively) can't hang.
    hops = 0
    while cursor is not None and hops < 64:
        trail.append(BreadcrumbEntry(id=cursor.id, name=cursor.name))
        if cursor.parent_id is None:
            break
        cursor = await db.get(FileFolder, cursor.parent_id)
        hops += 1
    trail.reverse()
    return trail


# --------------------------------------------------------------------
# Browse
# --------------------------------------------------------------------
@router.get("/browse", response_model=BrowseResponse)
async def browse(
    scope: Scope = Query("mine"),
    folder_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> BrowseResponse:
    """List folders + files inside a given folder of the selected scope."""
    parent: FileFolder | None = None
    if folder_id is not None:
        parent = await _load_readable_folder(db, folder_id, user)
        # Scope in the URL must match the folder's actual pool.
        if _scope_of(parent.user_id) != scope:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder doesn't belong to the requested scope",
            )

    folder_filter = and_(
        _owner_filter(scope, user),
        (FileFolder.parent_id == parent.id)
        if parent is not None
        else FileFolder.parent_id.is_(None),
    )
    folder_rows = (
        (
            await db.execute(
                select(FileFolder)
                .where(folder_filter)
                .order_by(FileFolder.name.asc())
            )
        )
        .scalars()
        .all()
    )

    file_filter = and_(
        _file_owner_filter(scope, user),
        (UserFile.folder_id == parent.id)
        if parent is not None
        else UserFile.folder_id.is_(None),
    )
    file_rows = (
        (
            await db.execute(
                select(UserFile)
                .where(file_filter)
                .order_by(UserFile.filename.asc())
            )
        )
        .scalars()
        .all()
    )

    return BrowseResponse(
        scope=scope,
        folder=_folder_to_response(parent) if parent else None,
        breadcrumbs=await _build_breadcrumbs(db, parent),
        folders=[_folder_to_response(f) for f in folder_rows],
        files=[_file_to_response(f) for f in file_rows],
        writable=(scope == "mine") or user.role == "admin",
    )


# --------------------------------------------------------------------
# Folder CRUD
# --------------------------------------------------------------------
@router.post("/folders", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    payload: FolderCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    owner_id = _owner_for_scope(user, payload.scope)

    parent: FileFolder | None = None
    if payload.parent_id is not None:
        parent = await _load_writable_folder(db, payload.parent_id, user)
        if _scope_of(parent.user_id) != payload.scope:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Parent folder doesn't belong to the requested scope",
            )

    folder = FileFolder(
        user_id=owner_id,
        parent_id=parent.id if parent else None,
        name=payload.name.strip(),
    )
    db.add(folder)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A folder with that name already exists here",
        )
    await db.refresh(folder)
    return _folder_to_response(folder)


@router.patch("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: uuid.UUID,
    payload: FolderUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    folder = await _load_writable_folder(db, folder_id, user)

    if payload.name is not None:
        _assert_not_system_folder(folder, "rename")
        folder.name = payload.name.strip()

    if payload.parent_id is not None or payload.move_to_root:
        _assert_not_system_folder(folder, "move")
        new_parent: FileFolder | None = None
        if payload.parent_id is not None:
            new_parent = await _load_writable_folder(db, payload.parent_id, user)
            if _scope_of(new_parent.user_id) != _scope_of(folder.user_id):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot move between scopes",
                )
            if await _would_create_cycle(db, moving=folder, new_parent=new_parent):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot move a folder into one of its descendants",
                )
        folder.parent_id = new_parent.id if new_parent else None

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A folder with that name already exists here",
        )
    await db.refresh(folder)
    return _folder_to_response(folder)


async def _would_create_cycle(
    db: AsyncSession, *, moving: FileFolder, new_parent: FileFolder
) -> bool:
    """Return True if moving `moving` under `new_parent` would create a cycle."""
    if new_parent.id == moving.id:
        return True
    cursor: FileFolder | None = new_parent
    hops = 0
    while cursor is not None and hops < 64:
        if cursor.parent_id == moving.id:
            return True
        if cursor.parent_id is None:
            return False
        cursor = await db.get(FileFolder, cursor.parent_id)
        hops += 1
    return False


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    folder = await _load_writable_folder(db, folder_id, user)
    _assert_not_system_folder(folder, "delete")

    # Collect every descendant folder (BFS) so we can reach the files they
    # hold and wipe blobs off disk. The DB cascade handles the rows once we
    # commit; we just need to know which blobs to unlink.
    to_walk: list[uuid.UUID] = [folder.id]
    folder_ids: list[uuid.UUID] = []
    while to_walk:
        frontier = to_walk
        to_walk = []
        folder_ids.extend(frontier)
        children = (
            (
                await db.execute(
                    select(FileFolder.id).where(FileFolder.parent_id.in_(frontier))
                )
            )
            .scalars()
            .all()
        )
        to_walk.extend(children)

    file_rows = (
        (
            await db.execute(
                select(UserFile).where(UserFile.folder_id.in_(folder_ids))
            )
        )
        .scalars()
        .all()
    )
    storage_paths = [f.storage_path for f in file_rows]

    await db.delete(folder)
    await db.commit()

    for p in storage_paths:
        delete_blob(p)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# File upload / CRUD
# --------------------------------------------------------------------
async def _audit_upload_rejection(
    db: AsyncSession,
    *,
    request: Request,
    user: User,
    code: str,
    declared_filename: str | None,
) -> None:
    """Best-effort audit row for a refused upload. Never raises."""
    try:
        await record_event(
            db,
            request=request,
            event_type=EVENT_FILE_UPLOAD_REJECTED,
            user_id=user.id,
            identifier=user.username,
            detail=safe_dict(
                {
                    "code": code,
                    # Only the *trailing* component, since the full
                    # name might be PII-rich (real names, addresses)
                    # and the audit log is meant to be reviewable.
                    "filename": (declared_filename or "")[:120],
                }
            ),
        )
        # Audit row stands on its own — commit so we don't lose it
        # if the surrounding handler raises before it gets a chance.
        await db.commit()
    except Exception:  # noqa: BLE001 — audit must never break the response
        logger.exception("Failed to record file_upload_rejected audit event")


@router.get("/quota", response_model=StorageQuotaResponse)
async def get_storage_quota(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StorageQuotaResponse:
    """Return ``(cap, used)`` for the calling user's private pool.

    ``cap_bytes`` is null when no cap applies (per-user override is
    NULL *and* the org-wide default is NULL). The frontend uses this
    to draw a usage bar in the file picker.
    """
    quota = await get_quota(db, user)
    return StorageQuotaResponse(
        cap_bytes=quota.cap_bytes,
        used_bytes=quota.used_bytes,
        remaining_bytes=quota.remaining_bytes,
    )


@router.post("/", response_model=FileResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    request: Request,
    file: UploadFile,
    scope: Scope = Form("mine"),
    folder_id: uuid.UUID | None = Form(default=None),
    # Optional auto-routing hint: when the caller doesn't specify
    # ``folder_id`` and ``scope == "mine"``, the upload is dropped into
    # the matching system folder. Today only ``"chat"`` is wired up;
    # ``"generated"`` is reserved for a future "AI made this for you"
    # flow and will route by MIME type.
    route: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    owner_id = _owner_for_scope(user, scope)

    parent_folder: FileFolder | None = None
    if folder_id is not None:
        parent_folder = await _load_writable_folder(db, folder_id, user)
        if _scope_of(parent_folder.user_id) != scope:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder doesn't belong to the requested scope",
            )
    # If ``route`` requested an auto-routed destination we resolve it
    # *after* every validation step has passed (see step 7b below) so a
    # rejected upload doesn't leave an empty system folder behind.

    # ----- 1) Sanitise filename + extension allowlist -----
    # Done up front, before we ever touch the disk, so a hostile
    # filename can't even create a transient file inside the upload
    # bucket.
    try:
        clean_name = sanitize_filename(file.filename)
    except UnsafeUploadError as e:
        await _audit_upload_rejection(
            db,
            request=request,
            user=user,
            code=e.code,
            declared_filename=file.filename,
        )
        await file.close()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    ext = os.path.splitext(clean_name)[1].lower()
    declared_mime = file.content_type

    # ----- 2) Storage cap pre-check (cheap, can save a write) -----
    # We don't know the exact final size until the body is on disk,
    # but if the user is *already* over their cap there's no point
    # streaming bytes only to roll them back. Recheck after the
    # write completes for the actual exact-size enforcement.
    quota: StorageQuota | None = None
    if owner_id is not None:
        quota = await get_quota(db, user)
        if quota.cap_bytes is not None and quota.used_bytes >= quota.cap_bytes:
            await _audit_upload_rejection(
                db,
                request=request,
                user=user,
                code="storage_cap",
                declared_filename=clean_name,
            )
            await file.close()
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    "You've reached your storage limit. Delete some files or "
                    "ask an admin to raise your quota."
                ),
            )

    # ----- 3) Stream to disk (subject to per-file ceiling) -----
    new_id = uuid.uuid4()
    rel_path = storage_path_for(owner_id, new_id, ext)
    ensure_bucket(owner_id)

    try:
        size = copy_stream_to_disk(file.file, rel_path, size_limit=MAX_FILE_BYTES)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds maximum size of {MAX_FILE_BYTES // (1024 * 1024)} MB",
        )
    finally:
        await file.close()

    abs_path = absolute_path(rel_path)

    # ----- 4) Magic-byte sniff -----
    # Reading the first ~261 bytes off disk is cheaper + more
    # reliable than tee-ing the upload stream.
    try:
        canonical_mime = sniff_and_validate(
            abs_path,
            declared_filename=clean_name,
            declared_mime=declared_mime,
        )
    except UnsafeUploadError as e:
        delete_blob(rel_path)
        await _audit_upload_rejection(
            db,
            request=request,
            user=user,
            code=e.code,
            declared_filename=clean_name,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # ----- 5) Storage cap post-check (now that we know the real size) -----
    if quota is not None and quota.cap_bytes is not None:
        # ``used_bytes`` was the snapshot *before* this upload — add
        # the freshly-written ``size`` to compare against the cap.
        if quota.used_bytes + size > quota.cap_bytes:
            delete_blob(rel_path)
            await _audit_upload_rejection(
                db,
                request=request,
                user=user,
                code="storage_cap",
                declared_filename=clean_name,
            )
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    "This upload would push you over your storage limit. "
                    "Delete some files or ask an admin to raise your quota."
                ),
            )

    # ----- 6) EXIF / GPS strip (best effort, images only) -----
    strip_image_metadata_in_place(abs_path, canonical_mime)
    # The re-encode in step 6 may have changed the byte count — refresh
    # so the row matches reality and the cap math stays honest.
    try:
        size = abs_path.stat().st_size
    except OSError:
        pass

    # ----- 7) Resolve the auto-routed destination (now that we know
    # the upload will succeed) -----
    if parent_folder is None and scope == "mine":
        if route == "chat":
            parent_folder = await folder_for_chat_upload(db, user)
        elif route == "generated":
            # Reserved for the future "AI made this for you" flow —
            # routes by MIME so images/audio/video land in Media and
            # everything else (including PDFs) lands in Files.
            parent_folder = await folder_for_generated(
                db, user, canonical_mime
            )

    # ----- 8) Persist the row -----
    row = UserFile(
        id=new_id,
        user_id=owner_id,
        folder_id=parent_folder.id if parent_folder else None,
        filename=clean_name,
        original_filename=clean_name,
        mime_type=canonical_mime,
        size_bytes=size,
        storage_path=rel_path,
    )
    db.add(row)
    try:
        await db.commit()
    except Exception:
        # If the DB insert fails, get rid of the orphaned blob so we don't
        # accumulate garbage on disk.
        delete_blob(rel_path)
        raise
    await db.refresh(row)
    return _file_to_response(row)


@router.get("/{file_id}", response_model=FileResponse)
async def get_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_readable_file(db, file_id, user)
    return _file_to_response(row)


def _safe_download_mime(stored_mime: str, filename: str) -> str:
    """Pick the ``Content-Type`` to send back to the browser.

    Resolution order:
    * If the filename's extension is on the upload allowlist, use the
      *canonical* MIME the allowlist defines. This means even a
      malformed row left over from before the Phase 3 hardening can't
      surprise the browser with ``text/html`` for a ``.png``.
    * Otherwise fall back to ``application/octet-stream`` so the
      browser triggers a save-dialog instead of trying to render.

    We deliberately ignore the stored ``mime_type`` when the
    extension is allowlisted — it's a defence-in-depth move; the
    upload path already wrote the canonical value.
    """
    try:
        return canonical_mime_for(filename)
    except KeyError:
        # Any pre-Phase-3 row whose extension we no longer trust
        # downloads as a binary stream. Safe by default.
        return "application/octet-stream"


def _content_disposition(filename: str) -> str:
    """Build a safe ``Content-Disposition`` header value.

    Always ``attachment`` — never ``inline`` — so a malicious image
    or HTML doc can't render in the browser and exfiltrate from the
    same origin as the rest of the app.

    Uses the RFC 5987 dual-form (``filename=...; filename*=...``) so
    ASCII clients render the legacy fallback and Unicode-aware ones
    get the full original. Quotes are escaped per RFC 6266.
    """
    fallback = filename.encode("ascii", errors="replace").decode("ascii")
    fallback = fallback.replace('"', "_").replace("\\", "_")
    encoded = urllib.parse.quote(filename, safe="")
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{encoded}'


@router.get("/{file_id}/download")
async def download_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FastAPIFileResponse:
    row = await _load_readable_file(db, file_id, user)
    path = absolute_path(row.storage_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File data missing on disk"
        )
    media_type = _safe_download_mime(row.mime_type, row.filename)
    return FastAPIFileResponse(
        path=str(path),
        media_type=media_type,
        headers={
            # RFC 6266 attachment disposition — never inline.
            "Content-Disposition": _content_disposition(row.filename),
            # Defence-in-depth headers so a stale or hostile blob
            # can't be sniffed into a script context even if a future
            # change accidentally drops the canonical MIME path.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


# --------------------------------------------------------------------
# Phase A3 — editable source for AI-generated artefacts
# --------------------------------------------------------------------
async def _resolve_source_pair(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> tuple[UserFile, UserFile]:
    """Return (rendered_file, source_file) for ``file_id``.

    ``file_id`` is the *rendered* file id (the one the user sees in
    chat as a chip). We load it, confirm it's a rendered artefact with
    a linked source, then load the source and confirm the user owns
    both. Returns a 404 (not 400) for any failure mode the user could
    plausibly trigger by guessing an id, so we never leak the
    existence of files in other pools.
    """
    rendered = await _load_writable_file(db, file_id, user)
    if rendered.source_kind != GeneratedKind.RENDERED_PDF.value:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No editable source for this file",
        )
    if rendered.source_file_id is None:
        # A rendered file without a source link is a Phase-A2 oddity
        # (e.g. the source was deleted out from under it). Treat it as
        # not-editable so the side panel cleanly degrades to read-only.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Source for this file is no longer available",
        )
    source = await db.get(UserFile, rendered.source_file_id)
    if source is None or not _can_write(source.user_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Source for this file is no longer available",
        )
    return rendered, source


@router.get("/{file_id}/source", response_model=SourceContentResponse)
async def get_file_source(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SourceContentResponse:
    """Return the editable Markdown source backing a rendered PDF.

    The Phase A3 side-panel editor calls this when the user clicks a
    PDF chip in chat. The frontend hands the *rendered* file id (the
    PDF) and we follow ``source_file_id`` to load the source.
    """
    rendered, source = await _resolve_source_pair(db, file_id, user)
    path = absolute_path(source.storage_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Source file is missing on disk",
        )
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        # We only currently store Markdown sources, which are UTF-8 by
        # construction. A non-decodable body means something went very
        # wrong — refuse to half-render in the editor.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Source file is not valid UTF-8",
        )
    return SourceContentResponse(
        rendered_file_id=rendered.id,
        rendered_filename=rendered.filename,
        rendered_size_bytes=rendered.size_bytes,
        source_file_id=source.id,
        source_filename=source.filename,
        source_mime_type=source.mime_type,
        source_size_bytes=source.size_bytes,
        content=content,
    )


@router.put("/{file_id}/source", response_model=SourceContentResponse)
async def update_file_source(
    file_id: uuid.UUID,
    payload: SourceUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SourceContentResponse:
    """Save edited Markdown and re-render the linked PDF in place.

    Pipeline:

    1. Resolve the (rendered, source) pair and verify ownership.
    2. Overwrite the source blob with the new Markdown via the atomic-
       rename helper (the original bytes survive any disk failure).
    3. Re-run :func:`render_markdown_to_pdf` on the new source.
    4. Overwrite the rendered PDF blob with the new bytes — same id,
       same path. Every chip already in chat history picks up the new
       content the next time the user clicks download.
    5. Audit-log the edit.

    If step 3 fails (e.g. the user pasted broken markup), step 2 has
    already committed — the user keeps their text changes but the PDF
    is now stale. We surface a 422 with a clear message and audit the
    failure so they know to fix the source and save again.
    """
    # Local import — pulling chat code at module import time would set
    # up a (small but real) cycle since chat depends on files.
    from app.chat.pdf_render import (
        PdfRenderError,
        render_markdown_to_pdf,
    )

    rendered, source = await _resolve_source_pair(db, file_id, user)
    new_text = payload.content
    new_bytes = new_text.encode("utf-8")

    # --- Step 1: overwrite the Markdown source ------------------------
    try:
        await overwrite_generated_file(
            db, user=user, file=source, content=new_bytes
        )
    except GeneratedFileError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    # --- Step 2: re-render the PDF -----------------------------------
    try:
        # Sync, CPU-bound — offload so the event loop stays responsive
        # for other connections. ``run_in_threadpool`` would also work;
        # ``asyncio.to_thread`` is the stdlib equivalent.
        import asyncio as _asyncio  # local import keeps top of file tidy

        pdf_bytes = await _asyncio.to_thread(
            render_markdown_to_pdf, new_text, None
        )
    except PdfRenderError as e:
        await record_event(
            db,
            request=request,
            user_id=user.id,
            event_type=EVENT_GENERATED_RERENDER_FAILED,
            detail=safe_dict(
                {
                    "rendered_file_id": str(rendered.id),
                    "source_file_id": str(source.id),
                    "error": type(e).__name__,
                }
            ),
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Source saved, but re-rendering failed: {e}. "
                "Edit the source and save again."
            ),
        )
    except Exception as e:  # pragma: no cover — defensive
        await record_event(
            db,
            request=request,
            user_id=user.id,
            event_type=EVENT_GENERATED_RERENDER_FAILED,
            detail=safe_dict(
                {
                    "rendered_file_id": str(rendered.id),
                    "source_file_id": str(source.id),
                    "error": type(e).__name__,
                }
            ),
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Source saved, but the renderer crashed unexpectedly. "
                "Try simpler markup."
            ),
        )

    # --- Step 3: overwrite the PDF in place --------------------------
    try:
        await overwrite_generated_file(
            db, user=user, file=rendered, content=pdf_bytes
        )
    except GeneratedFileError as e:
        # Source already saved; tell the user the PDF stayed stale.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Source saved, PDF could not be overwritten: {e}",
        )

    await record_event(
        db,
        request=request,
        user_id=user.id,
        event_type=EVENT_GENERATED_SOURCE_EDITED,
        detail=safe_dict(
            {
                "rendered_file_id": str(rendered.id),
                "source_file_id": str(source.id),
                "source_bytes": len(new_bytes),
                "rendered_bytes": len(pdf_bytes),
            }
        ),
    )
    await db.commit()
    await db.refresh(rendered)
    await db.refresh(source)

    return SourceContentResponse(
        rendered_file_id=rendered.id,
        rendered_filename=rendered.filename,
        rendered_size_bytes=rendered.size_bytes,
        source_file_id=source.id,
        source_filename=source.filename,
        source_mime_type=source.mime_type,
        source_size_bytes=source.size_bytes,
        content=new_text,
    )


@router.patch("/{file_id}", response_model=FileResponse)
async def update_file(
    file_id: uuid.UUID,
    payload: FileUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_writable_file(db, file_id, user)

    if payload.filename is not None:
        row.filename = payload.filename.strip()

    if payload.folder_id is not None or payload.move_to_root:
        new_folder: FileFolder | None = None
        if payload.folder_id is not None:
            new_folder = await _load_writable_folder(db, payload.folder_id, user)
            if _scope_of(new_folder.user_id) != _scope_of(row.user_id):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot move between scopes",
                )
        row.folder_id = new_folder.id if new_folder else None

    await db.commit()
    await db.refresh(row)
    return _file_to_response(row)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = await _load_writable_file(db, file_id, user)
    storage = row.storage_path
    await db.delete(row)
    await db.commit()
    delete_blob(storage)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Internal helpers for the chat router
# --------------------------------------------------------------------
async def resolve_attachments(
    db: AsyncSession, ids: Iterable[uuid.UUID], user: User
) -> list[UserFile]:
    """Load every attachment the user claims, enforcing ACLs.

    Raises HTTPException(400) if any ID is unknown / unreadable to the caller.
    """
    id_list = list(ids)
    if not id_list:
        return []
    rows = (
        (
            await db.execute(
                select(UserFile).where(UserFile.id.in_(id_list))
            )
        )
        .scalars()
        .all()
    )
    by_id = {r.id: r for r in rows}
    resolved: list[UserFile] = []
    for file_id in id_list:
        row = by_id.get(file_id)
        if row is None or not _can_read(row.user_id, user):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown or inaccessible attachment: {file_id}",
            )
        resolved.append(row)
    return resolved


def attachment_snapshot(f: UserFile) -> dict[str, Any]:
    """Frozen metadata dict to persist on messages.attachments.

    ``source_kind`` / ``source_file_id`` are surfaced (Phase B3) so the
    frontend can tell whether a PDF chip should open the editable
    Markdown side panel (rendered artefact with a linked source) or
    the read-only PDF preview (everything else, including ordinary
    user uploads). Both are nullable — pure user uploads have no
    provenance metadata, and that's the signal the preview path keys
    on. The values are stable ``GeneratedKind`` strings, so chips
    persisted in older messages keep rendering correctly forever even
    if we extend the enum later.
    """
    return {
        "id": str(f.id),
        "filename": f.filename,
        "mime_type": f.mime_type,
        "size_bytes": f.size_bytes,
        "source_kind": f.source_kind,
        "source_file_id": str(f.source_file_id) if f.source_file_id else None,
    }


__all__ = [
    "router",
    "resolve_attachments",
    "attachment_snapshot",
]

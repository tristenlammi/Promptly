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
import secrets as _secrets
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
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
from sqlalchemy import and_, delete as sa_delete, func, select
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
from app.files.models import (
    FileFolder,
    FileShareGrant,
    FileShareLink,
    ResourceGrant,
    UserFile,
)
from app.files.quota import StorageQuota, get_quota
from app.files.sharing import (
    assert_file_shareable,
    assert_folder_shareable,
    build_summary_for_resource,
    bulk_summaries,
    caller_grants_for_file,
    caller_grants_for_folder,
    expand_folder_subtree,
    file_ids_caller_is_granted,
    folder_ids_caller_is_granted,
    grants_for_resource,
)
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
    MAX_GRANTS_PER_RESOURCE,
    BreadcrumbEntry,
    BrowseResponse,
    CopyToMineResponse,
    CreateGrantRequest,
    FileResponse,
    FileSearchHit,
    FileSearchResponse,
    FileUpdateRequest,
    FolderCreateRequest,
    FolderResponse,
    FolderUpdateRequest,
    GrantsListResponse,
    GrantSummary,
    RecentFilesResponse,
    Scope,
    ShareAccessMode,
    ShareFolderBrowseResponse,
    ShareLinkCreateRequest,
    ShareLinkListResponse,
    ShareLinkMetaResponse,
    ShareLinkResponse,
    ShareLinkUnlockRequest,
    ShareLinkUnlockResponse,
    SourceContentResponse,
    SourceUpdateRequest,
    StarredListResponse,
    StorageQuotaResponse,
    TrashListResponse,
    UpdateGrantRequest,
    UserSearchResponse,
    UserSearchResult,
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
def _scope_of_for_caller(
    owner_id: uuid.UUID | None, caller: User
) -> Scope:
    """Return the bucket the caller sees this row in.

    Post-0042 the legacy admin-pool concept is gone: every row has
    an owner. The "shared" scope now means "appears in the caller's
    Shared tab" — i.e. they're either a grantee or the owner of a
    row that has at least one outstanding grant. The caller-aware
    bucket is decided by whoever calls this; default fallback is
    ``"mine"`` when the caller is the owner.
    """
    if owner_id is not None and owner_id == caller.id:
        return "mine"
    return "shared"


def _owner_for_scope(user: User, scope: Scope) -> uuid.UUID:
    """Return the ``user_id`` we should stamp on a new row.

    Writes always go into the caller's own pool now — there's no
    admin-managed shared pool to write into anymore. The ``scope``
    argument is kept for API symmetry but ignored: any caller
    attempting to *create* something under ``scope=shared`` is
    politely redirected to the new sharing model.
    """
    if scope == "shared":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "The 'Shared' tab now lists folders/files shared with you "
                "or by you. To create something new, use 'My files' and "
                "share it from there."
            ),
        )
    return user.id


def _folder_to_response(
    folder: FileFolder,
    *,
    caller: User,
    sharing: GrantSummary | None = None,
) -> FolderResponse:
    return FolderResponse(
        id=folder.id,
        parent_id=folder.parent_id,
        name=folder.name,
        scope=_scope_of_for_caller(folder.user_id, caller),
        created_at=folder.created_at,
        system_kind=folder.system_kind,
        updated_at=folder.updated_at,
        starred_at=folder.starred_at,
        trashed_at=folder.trashed_at,
        sharing=sharing,
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


def _file_to_response(
    f: UserFile,
    *,
    caller: User,
    sharing: GrantSummary | None = None,
) -> FileResponse:
    return FileResponse(
        id=f.id,
        folder_id=f.folder_id,
        filename=f.filename,
        mime_type=f.mime_type,
        size_bytes=f.size_bytes,
        scope=_scope_of_for_caller(f.user_id, caller),
        created_at=f.created_at,
        updated_at=f.updated_at,
        starred_at=f.starred_at,
        trashed_at=f.trashed_at,
        source_kind=f.source_kind,
        sharing=sharing,
        source_file_id=f.source_file_id,
    )


async def _load_readable_folder(
    db: AsyncSession, folder_id: uuid.UUID, user: User
) -> FileFolder:
    folder = await db.get(FileFolder, folder_id)
    if folder is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )
    if folder.user_id == user.id:
        return folder
    # Drive stage 5 — peer-to-peer share grants. The caller may be a
    # grantee on this folder directly, or on any ancestor folder
    # (folder grants cascade down through the subtree). 404 instead
    # of 403 so we don't leak the existence of someone else's
    # private folders.
    grants = await caller_grants_for_folder(db, folder, user)
    if grants:
        return folder
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
    )


async def _load_writable_folder(
    db: AsyncSession, folder_id: uuid.UUID, user: User
) -> FileFolder:
    folder = await _load_readable_folder(db, folder_id, user)
    if folder.user_id != user.id:
        # Grantees can read but not write — folder-level mutations
        # (rename, move, trash, upload-into) are owner-only.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have write access to this folder",
        )
    return folder


async def _load_readable_file(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> UserFile:
    row = await db.get(UserFile, file_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )
    if row.user_id is not None and row.user_id == user.id:
        return row
    # Project-share side-door: a collaborator on a shared project
    # can read any file pinned to that project (including files
    # owned by the project creator or other collaborators). Without
    # this path the chat-preamble download links inside a shared
    # project 404 for anyone but the pin's original owner.
    if await _file_is_accessible_via_project(db, row.id, user):
        return row
    # Drive stage 5 — direct file grant or a grant on any ancestor
    # folder. Both paths route through the same helper which walks
    # ``folder_id`` up to the root.
    grants = await caller_grants_for_file(db, row, user)
    if grants:
        return row
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
    )


async def _file_is_accessible_via_project(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> bool:
    """Does ``user`` reach ``file_id`` through a shared project pin?

    Returns True if the file is pinned to any project the caller
    can access (owns or has an accepted share on). Isolated as a
    helper so the fast path in :func:`_load_readable_file` stays
    synchronous-ish (one ``SELECT`` then done) and we only issue
    the second query after the simple ownership check fails.
    """
    # Importing here keeps the files module free of a top-level
    # dependency on chat tables — the chat side already knows
    # everything about files, but not vice-versa.
    from app.chat.models import ChatProjectFile
    from app.chat.shares import list_accessible_project_ids
    from sqlalchemy import select as _select

    accessible_project_ids = await list_accessible_project_ids(user, db)
    if not accessible_project_ids:
        return False
    row = (
        await db.execute(
            _select(ChatProjectFile.file_id)
            .where(
                ChatProjectFile.file_id == file_id,
                ChatProjectFile.project_id.in_(accessible_project_ids),
            )
            .limit(1)
        )
    ).first()
    return row is not None


async def _load_writable_file(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> UserFile:
    row = await _load_readable_file(db, file_id, user)
    if row.user_id is None or row.user_id != user.id:
        # Grantees never get write — even those with ``can_copy=True``
        # should clone the file into their own Drive instead of
        # mutating the owner's row.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have write access to this file",
        )
    return row


def _owner_filter(user: User):
    """Filter for caller-owned folders only (used by ``scope=mine``)."""
    return FileFolder.user_id == user.id


def _file_owner_filter(user: User):
    """Filter for caller-owned files only (used by ``scope=mine``)."""
    return UserFile.user_id == user.id


# Drive document assets (images / audio pasted or dropped inside a
# TipTap document) ride on a ``UserFile`` row so they get the same
# storage accounting + auth path as anything else uploaded to Drive,
# but they're implementation detail of the owning document and must
# never appear in Drive listings. Every listing query (/browse,
# /recent, /starred, /trash, /search) joins on this filter.
def _drive_listing_filter():
    """Exclude per-document inline assets from Drive listings.

    Documents themselves (``source_kind = "document"``) *do* show up
    — only the hidden asset bucket is filtered out. Rows with a NULL
    ``source_kind`` are ordinary uploads and pass through untouched.
    """
    from sqlalchemy import or_

    return or_(
        UserFile.source_kind.is_(None),
        UserFile.source_kind != GeneratedKind.DOCUMENT_ASSET.value,
    )


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
    """List folders + files inside a given folder of the selected scope.

    ``scope=mine`` returns the caller's own pool exactly as before.

    ``scope=shared`` is the new peer-to-peer model: at root it lists
    every file/folder the caller has been granted access to **plus**
    every file/folder the caller owns that has at least one
    outstanding grant. Drilling into a shared folder traverses its
    real subtree (folder grants cascade); the breadcrumb stops at
    the shared root so the caller can't navigate out into the
    owner's private drive.
    """
    parent: FileFolder | None = None
    if folder_id is not None:
        parent = await _load_readable_folder(db, folder_id, user)

    if scope == "mine":
        return await _browse_mine(db, user, parent)
    return await _browse_shared(db, user, parent)


async def _browse_mine(
    db: AsyncSession, user: User, parent: FileFolder | None
) -> BrowseResponse:
    if parent is not None and parent.user_id != user.id:
        # The caller can read this folder via a grant, but it's not
        # in their "My files" view — guide them to the Shared tab.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This folder lives in your Shared tab, not My files.",
        )

    folder_filter = and_(
        _owner_filter(user),
        (FileFolder.parent_id == parent.id)
        if parent is not None
        else FileFolder.parent_id.is_(None),
        FileFolder.trashed_at.is_(None),
    )
    folder_rows = (
        await db.execute(
            select(FileFolder)
            .where(folder_filter)
            .order_by(FileFolder.name.asc())
        )
    ).scalars().all()

    file_filter = and_(
        _file_owner_filter(user),
        (UserFile.folder_id == parent.id)
        if parent is not None
        else UserFile.folder_id.is_(None),
        UserFile.trashed_at.is_(None),
        _drive_listing_filter(),
    )
    file_rows = (
        await db.execute(
            select(UserFile)
            .where(file_filter)
            .order_by(UserFile.filename.asc())
        )
    ).scalars().all()

    file_summaries, folder_summaries = await bulk_summaries(
        db,
        files=list(file_rows),
        folders=list(folder_rows),
        caller=user,
    )

    return BrowseResponse(
        scope="mine",
        folder=_folder_to_response(
            parent, caller=user,
            sharing=folder_summaries.get(parent.id) if parent else None,
        ) if parent else None,
        breadcrumbs=await _build_breadcrumbs(db, parent),
        folders=[
            _folder_to_response(
                f, caller=user, sharing=folder_summaries.get(f.id)
            )
            for f in folder_rows
        ],
        files=[
            _file_to_response(
                f, caller=user, sharing=file_summaries.get(f.id)
            )
            for f in file_rows
        ],
        writable=True,
    )


async def _browse_shared(
    db: AsyncSession, user: User, parent: FileFolder | None
) -> BrowseResponse:
    """Shared tab listing.

    Root view (parent is None): assemble the union of:

    * folders the caller is a grantee on (top-level folder grants,
      not their descendants — those live one click in)
    * files the caller is a grantee on (direct file grants only)
    * folders the caller owns that have ANY grant on them
    * files the caller owns that have ANY grant on them

    Inside-folder view: list ``parent``'s direct children. Access
    to ``parent`` was already verified by ``_load_readable_folder``
    above.
    """
    if parent is None:
        return await _shared_root(db, user)
    return await _shared_inside(db, user, parent)


async def _shared_root(db: AsyncSession, user: User) -> BrowseResponse:
    # 1) Caller is a grantee on these folder ids.
    grantee_folder_ids = await folder_ids_caller_is_granted(db, user)
    grantee_folders: list[FileFolder] = []
    if grantee_folder_ids:
        rows = (
            await db.execute(
                select(FileFolder).where(
                    FileFolder.id.in_(grantee_folder_ids),
                    FileFolder.trashed_at.is_(None),
                )
            )
        ).scalars().all()
        grantee_folders = list(rows)

    # 2) Caller is a grantee on these file ids.
    grantee_file_ids = await file_ids_caller_is_granted(db, user)
    grantee_files: list[UserFile] = []
    if grantee_file_ids:
        rows = (
            await db.execute(
                select(UserFile).where(
                    UserFile.id.in_(grantee_file_ids),
                    UserFile.trashed_at.is_(None),
                    _drive_listing_filter(),
                )
            )
        ).scalars().all()
        grantee_files = list(rows)

    # 3) Caller-owned folders/files that have at least one grant.
    owned_shared_folder_ids = (
        await db.execute(
            select(ResourceGrant.resource_id)
            .join(
                FileFolder,
                (FileFolder.id == ResourceGrant.resource_id)
                & (ResourceGrant.resource_type == "folder"),
            )
            .where(
                FileFolder.user_id == user.id,
                FileFolder.trashed_at.is_(None),
            )
            .distinct()
        )
    ).scalars().all()
    owned_shared_folders: list[FileFolder] = []
    if owned_shared_folder_ids:
        rows = (
            await db.execute(
                select(FileFolder).where(
                    FileFolder.id.in_(owned_shared_folder_ids)
                )
            )
        ).scalars().all()
        owned_shared_folders = list(rows)

    owned_shared_file_ids = (
        await db.execute(
            select(ResourceGrant.resource_id)
            .join(
                UserFile,
                (UserFile.id == ResourceGrant.resource_id)
                & (ResourceGrant.resource_type == "file"),
            )
            .where(
                UserFile.user_id == user.id,
                UserFile.trashed_at.is_(None),
            )
            .distinct()
        )
    ).scalars().all()
    owned_shared_files: list[UserFile] = []
    if owned_shared_file_ids:
        rows = (
            await db.execute(
                select(UserFile).where(
                    UserFile.id.in_(owned_shared_file_ids),
                    _drive_listing_filter(),
                )
            )
        ).scalars().all()
        owned_shared_files = list(rows)

    # Merge + de-dupe (an owner who's also a grantee on someone
    # else's grant of their own row shouldn't ever happen, but
    # defensively...).
    folders_by_id: dict[uuid.UUID, FileFolder] = {}
    for f in grantee_folders + owned_shared_folders:
        folders_by_id[f.id] = f
    files_by_id: dict[uuid.UUID, UserFile] = {}
    for f in grantee_files + owned_shared_files:
        files_by_id[f.id] = f

    folder_list = sorted(folders_by_id.values(), key=lambda f: f.name.lower())
    file_list = sorted(files_by_id.values(), key=lambda f: f.filename.lower())

    file_summaries, folder_summaries = await bulk_summaries(
        db, files=file_list, folders=folder_list, caller=user
    )

    return BrowseResponse(
        scope="shared",
        folder=None,
        # The Drive UI's <Breadcrumbs/> already renders the
        # scope-aware home anchor ("My files" / "Shared"), so the
        # backend doesn't need to emit a synthetic root entry — that
        # used to double-render as "Shared > Shared".
        breadcrumbs=[],
        folders=[
            _folder_to_response(
                f, caller=user, sharing=folder_summaries.get(f.id)
            )
            for f in folder_list
        ],
        files=[
            _file_to_response(
                f, caller=user, sharing=file_summaries.get(f.id)
            )
            for f in file_list
        ],
        writable=False,
    )


async def _shared_inside(
    db: AsyncSession, user: User, parent: FileFolder
) -> BrowseResponse:
    # Direct children only — folder grants cascade so descendants
    # of ``parent`` are readable too.
    folder_rows = (
        await db.execute(
            select(FileFolder)
            .where(
                FileFolder.parent_id == parent.id,
                FileFolder.trashed_at.is_(None),
            )
            .order_by(FileFolder.name.asc())
        )
    ).scalars().all()
    file_rows = (
        await db.execute(
            select(UserFile)
            .where(
                UserFile.folder_id == parent.id,
                UserFile.trashed_at.is_(None),
                _drive_listing_filter(),
            )
            .order_by(UserFile.filename.asc())
        )
    ).scalars().all()

    file_summaries, folder_summaries = await bulk_summaries(
        db, files=list(file_rows), folders=list(folder_rows), caller=user
    )

    # Breadcrumbs: walk up from ``parent`` but only as far as the
    # caller can read. The first ancestor they can't reach is
    # outside their share — chop it.
    crumbs = await _shared_breadcrumbs(db, user, parent)

    return BrowseResponse(
        scope="shared",
        folder=_folder_to_response(
            parent, caller=user,
            sharing=(
                await build_summary_for_resource(
                    db,
                    resource_type="folder",
                    resource_id=parent.id,
                    owner_user_id=parent.user_id,
                    caller=user,
                )
                if parent.user_id is not None
                else None
            ),
        ),
        breadcrumbs=crumbs,
        folders=[
            _folder_to_response(
                f, caller=user, sharing=folder_summaries.get(f.id)
            )
            for f in folder_rows
        ],
        files=[
            _file_to_response(
                f, caller=user, sharing=file_summaries.get(f.id)
            )
            for f in file_rows
        ],
        writable=parent.user_id == user.id,
    )


async def _shared_breadcrumbs(
    db: AsyncSession, user: User, parent: FileFolder
) -> list[BreadcrumbEntry]:
    """Breadcrumbs for a folder reached through the Shared tab.

    Walks up from ``parent`` and includes every ancestor the caller
    can read (owner = always; grantee = grant on this folder or any
    further ancestor). The first ancestor without read access caps
    the chain — we don't expose folders the caller couldn't have
    landed on directly. The synthetic "Shared" home anchor is
    rendered by the frontend's ``<Breadcrumbs/>`` component, so we
    deliberately don't prepend it here (otherwise it would double
    up as "Shared > Shared").
    """
    chain: list[FileFolder] = []
    cursor: FileFolder | None = parent
    hops = 0
    while cursor is not None and hops < 64:
        if cursor.user_id != user.id:
            grants = await caller_grants_for_folder(db, cursor, user)
            if not grants:
                break
        chain.append(cursor)
        if cursor.parent_id is None:
            break
        cursor = await db.get(FileFolder, cursor.parent_id)
        hops += 1
    return [BreadcrumbEntry(id=f.id, name=f.name) for f in reversed(chain)]


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
        # ``_load_writable_folder`` already enforces ownership, so
        # the legacy "scope mismatch" check is redundant — every
        # writable folder lives in the caller's own pool.
        parent = await _load_writable_folder(db, payload.parent_id, user)

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
    return _folder_to_response(folder, caller=user)


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
            # Both folder and new_parent must be caller-owned —
            # ``_load_writable_folder`` already enforces that on
            # both ends, so a legacy scope-mismatch check is no
            # longer needed.
            new_parent = await _load_writable_folder(db, payload.parent_id, user)
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
    return _folder_to_response(folder, caller=user)


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
        # ``_load_writable_folder`` enforces caller-owns the folder.
        # Uploads always land in the caller's own pool — sharing
        # is granted afterwards by the share-modal flow.
        parent_folder = await _load_writable_folder(db, folder_id, user)
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

    # Reject empty uploads up front. Phone browsers occasionally deliver
    # a multipart body with zero bytes of payload when the app is
    # backgrounded mid-upload; sniff_and_validate would catch it a few
    # lines down, but failing here gives a clearer 400 and stops us from
    # auditing it as a MIME mismatch.
    if size == 0:
        delete_blob(rel_path)
        await _audit_upload_rejection(
            db,
            request=request,
            user=user,
            code="empty_upload",
            declared_filename=clean_name,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "The upload was empty. This often means the connection "
                "dropped mid-transfer — try attaching the file again."
            ),
        )

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

    # Final sanity check: never persist a 0-byte row. ``strip_image_metadata_in_place``
    # is defensive, but if *anything* still produced a 0-byte file (bind-mount
    # quirks, external process, …), failing here is much friendlier than shipping
    # an unusable row that trips "Invalid image data-url" downstream.
    if size <= 0:
        delete_blob(rel_path)
        await _audit_upload_rejection(
            db,
            request=request,
            user=user,
            code="empty_upload",
            declared_filename=clean_name,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "The upload finished but the file was empty on disk. "
                "Try attaching it again — if the problem keeps happening, "
                "re-save the image as a standard JPEG or PNG first."
            ),
        )

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

    # ----- 9) FTS content extraction (best effort, synchronous) -----
    # We run this *after* the commit so a failure here can't roll
    # back the upload. Text-ish files and PDFs populate
    # ``content_text`` so the Drive search index sees their
    # contents; everything else stays NULL and only the filename
    # side of ``content_tsv`` catches matches.
    from app.files.extraction import extract_content_text

    try:
        content_text = extract_content_text(row)
        if content_text is not None:
            row.content_text = content_text
            await db.commit()
            await db.refresh(row)
    except Exception:  # noqa: BLE001 — extraction must never break upload
        logger.exception(
            "FTS extraction failed for file %s; leaving content_text NULL",
            row.id,
        )
        # Roll back any partial session state so the upload response
        # still represents the clean persisted row.
        await db.rollback()

    return _file_to_response(row, caller=user)


@router.get("/{file_id}", response_model=FileResponse)
async def get_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_readable_file(db, file_id, user)
    # Build a grant summary so the preview modal / share-modal
    # opener gets the pill data without a second round trip. We
    # combine the file's own grants with any ancestor folder
    # grants that cover it (otherwise a grantee viewing a file
    # inside a shared folder would see "(no grants)" on a row
    # that's clearly shared).
    sharing = await _file_sharing_summary(db, row, user)
    return _file_to_response(row, caller=user, sharing=sharing)


async def _file_sharing_summary(
    db: AsyncSession, row: UserFile, caller: User
) -> GrantSummary | None:
    """Best-effort sharing summary for a single file.

    Combines direct file grants with the deepest ancestor folder
    grant chain so the preview banner reflects the actual chain
    of access. ``owner_user_id`` is taken from the file row when
    set, otherwise from the deepest ancestor folder we found.
    """
    direct = await grants_for_resource(
        db, resource_type="file", resource_id=row.id
    )
    summary = await build_summary_for_resource(
        db,
        resource_type="file",
        resource_id=row.id,
        owner_user_id=row.user_id or caller.id,
        caller=caller,
        direct_grants=direct,
    )
    return summary


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
    if source is None or source.user_id is None or source.user_id != user.id:
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

    # Keep the FTS index in sync with the new source text. Update
    # both the source row (plain text = the new markdown) and the
    # rendered row (re-extract from the freshly-generated PDF bytes
    # so searching finds words that only appeared post-render).
    from app.files.extraction import extract_content_text, extract_from_text

    try:
        source.content_text = extract_from_text(new_text)
        rendered.content_text = extract_content_text(rendered)
    except Exception:  # noqa: BLE001 — FTS must never break the save
        logger.exception(
            "FTS re-extraction failed for source %s / rendered %s",
            source.id,
            rendered.id,
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
            # Both the file and the destination must be caller-owned;
            # ``_load_writable_folder`` + ``_load_writable_file``
            # cover that. Legacy scope-mismatch check retired with
            # the admin pool.
            new_folder = await _load_writable_folder(db, payload.folder_id, user)
        row.folder_id = new_folder.id if new_folder else None

    await db.commit()
    await db.refresh(row)
    return _file_to_response(row, caller=user)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: uuid.UUID,
    purge: bool = Query(
        False,
        description=(
            "Bypass the Drive Trash and permanently delete the row + "
            "blob. Admin-only; ordinary callers always soft-trash."
        ),
    ),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete a file.

    Drive stage 1 rewrites the default behaviour from *hard delete*
    to *soft trash*: we stamp ``trashed_at`` on the row and leave
    the blob on disk. The real delete happens when the user calls
    ``DELETE /files/trash`` (empty trash) or restores + re-deletes
    via the admin-only ``?purge=true`` flag.

    Admins can still bypass the trash (useful for support / abuse
    flows) by passing ``?purge=true``. Non-admin callers get a 403
    if they try to use that flag, so a compromised frontend can't
    skip the safety net.
    """
    row = await _load_writable_file(db, file_id, user)

    if purge:
        if user.role != "admin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="purge=true is admin-only",
            )
        storage = row.storage_path
        await db.delete(row)
        await db.commit()
        delete_blob(storage)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Default path: soft-trash. Idempotent — re-trashing a trashed
    # row just refreshes the timestamp.
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Drive stage 1 — Trash / Restore / Empty trash
# --------------------------------------------------------------------
async def _descendant_folder_ids(
    db: AsyncSession, root_id: uuid.UUID
) -> list[uuid.UUID]:
    """Return ``root_id`` plus every descendant folder id (BFS).

    We deliberately iterate in Python rather than trust an adjacency
    CTE — the folder tree is bounded at 64 levels by the cycle check
    in :func:`_would_create_cycle`, and the overwhelming majority of
    Drive trees are < 10 levels deep. This keeps the query shape
    identical to the plain ``DELETE /folders/{id}`` path we already
    ship.
    """
    to_walk: list[uuid.UUID] = [root_id]
    collected: list[uuid.UUID] = []
    while to_walk:
        frontier = to_walk
        to_walk = []
        collected.extend(frontier)
        children = (
            (
                await db.execute(
                    select(FileFolder.id).where(
                        FileFolder.parent_id.in_(frontier)
                    )
                )
            )
            .scalars()
            .all()
        )
        to_walk.extend(children)
    return collected


@router.post("/{file_id}/trash", response_model=FileResponse)
async def trash_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    """Soft-delete a file.

    Idempotent — trashing an already-trashed file just refreshes
    the ``trashed_at`` timestamp so the "X deleted recently" list
    feels correct.
    """
    row = await _load_writable_file(db, file_id, user)
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return _file_to_response(row, caller=user)


@router.post("/{file_id}/restore", response_model=FileResponse)
async def restore_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_writable_file(db, file_id, user)
    row.trashed_at = None
    await db.commit()
    await db.refresh(row)
    return _file_to_response(row, caller=user)


@router.post("/folders/{folder_id}/trash", response_model=FolderResponse)
async def trash_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    """Soft-delete a folder and everything under it.

    Cascades to every descendant folder + every file whose
    ``folder_id`` is in that subtree. The cascade is run in a
    single UPDATE so partial failure is impossible — either the
    whole subtree lands in trash or nothing does.
    """
    from sqlalchemy import update

    folder = await _load_writable_folder(db, folder_id, user)
    _assert_not_system_folder(folder, "trash")

    now = datetime.now(timezone.utc)
    folder_ids = await _descendant_folder_ids(db, folder.id)

    await db.execute(
        update(FileFolder)
        .where(FileFolder.id.in_(folder_ids))
        .values(trashed_at=now)
    )
    await db.execute(
        update(UserFile)
        .where(UserFile.folder_id.in_(folder_ids))
        .values(trashed_at=now)
    )
    await db.commit()
    await db.refresh(folder)
    return _folder_to_response(folder, caller=user)


@router.post("/folders/{folder_id}/restore", response_model=FolderResponse)
async def restore_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    """Restore a folder subtree from the trash.

    We only un-trash descendants whose ``trashed_at`` matches the
    folder's ``trashed_at`` within a 5-second window — this keeps
    files the user *individually* trashed earlier from getting
    accidentally rescued when the parent folder is restored.
    """
    from sqlalchemy import update

    folder = await _load_writable_folder(db, folder_id, user)
    _assert_not_system_folder(folder, "restore")

    if folder.trashed_at is None:
        # Already live — idempotent.
        return _folder_to_response(folder, caller=user)

    window_low = folder.trashed_at - timedelta(seconds=5)
    window_high = folder.trashed_at + timedelta(seconds=5)
    folder_ids = await _descendant_folder_ids(db, folder.id)

    await db.execute(
        update(FileFolder)
        .where(
            FileFolder.id.in_(folder_ids),
            FileFolder.trashed_at.is_not(None),
            FileFolder.trashed_at >= window_low,
            FileFolder.trashed_at <= window_high,
        )
        .values(trashed_at=None)
    )
    await db.execute(
        update(UserFile)
        .where(
            UserFile.folder_id.in_(folder_ids),
            UserFile.trashed_at.is_not(None),
            UserFile.trashed_at >= window_low,
            UserFile.trashed_at <= window_high,
        )
        .values(trashed_at=None)
    )
    await db.commit()
    await db.refresh(folder)
    return _folder_to_response(folder, caller=user)


@router.get("/trash", response_model=TrashListResponse)
async def list_trash(
    scope: Scope = Query("mine"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TrashListResponse:
    """List trashed folders + files in ``scope``.

    Ordered by ``trashed_at DESC`` so the most-recently-trashed row
    is first — matches the Drive UX. Admins see the shared-pool
    trash when they pass ``scope=shared``.
    """
    folder_filter = and_(
        _owner_filter(user),
        FileFolder.trashed_at.is_not(None),
    )
    folder_rows = (
        (
            await db.execute(
                select(FileFolder)
                .where(folder_filter)
                .order_by(FileFolder.trashed_at.desc())
            )
        )
        .scalars()
        .all()
    )

    file_filter = and_(
        _file_owner_filter(user),
        UserFile.trashed_at.is_not(None),
        _drive_listing_filter(),
    )
    file_rows = (
        (
            await db.execute(
                select(UserFile)
                .where(file_filter)
                .order_by(UserFile.trashed_at.desc())
            )
        )
        .scalars()
        .all()
    )

    return TrashListResponse(
        folders=[_folder_to_response(f, caller=user) for f in folder_rows],
        files=[_file_to_response(f, caller=user) for f in file_rows],
    )


@router.delete("/trash", status_code=status.HTTP_204_NO_CONTENT)
async def empty_trash(
    scope: Scope = Query("mine"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete every trashed row in ``scope``.

    Blob deletion is best-effort and runs *after* the commit so a
    half-failed unlink can't leave orphan DB rows. We intentionally
    don't use a transactional two-phase commit here — a leftover
    blob on disk is harmless (next upload reuses the bucket), but
    a leftover DB row with no blob would 404 on download.
    """
    if scope == "shared" and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can empty the shared trash",
        )

    file_rows = (
        (
            await db.execute(
                select(UserFile).where(
                    _file_owner_filter(user),
                    UserFile.trashed_at.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )
    folder_rows = (
        (
            await db.execute(
                select(FileFolder).where(
                    _owner_filter(user),
                    FileFolder.trashed_at.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )

    storage_paths = [f.storage_path for f in file_rows]
    for row in file_rows:
        await db.delete(row)
    for folder in folder_rows:
        # System folders can't be trashed in the first place, but
        # double-check before the nuke so a misfired admin flag
        # can't accidentally delete the Chat Uploads folder.
        if folder.system_kind is not None:
            continue
        await db.delete(folder)

    await db.commit()

    for p in storage_paths:
        delete_blob(p)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Drive stage 1 — Starred / Recent
# --------------------------------------------------------------------
@router.post("/{file_id}/star", response_model=FileResponse)
async def star_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_writable_file(db, file_id, user)
    if row.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't star a trashed file. Restore it first.",
        )
    if row.starred_at is None:
        row.starred_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(row)
    return _file_to_response(row, caller=user)


@router.delete("/{file_id}/star", response_model=FileResponse)
async def unstar_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_writable_file(db, file_id, user)
    row.starred_at = None
    await db.commit()
    await db.refresh(row)
    return _file_to_response(row, caller=user)


@router.post("/folders/{folder_id}/star", response_model=FolderResponse)
async def star_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    folder = await _load_writable_folder(db, folder_id, user)
    if folder.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't star a trashed folder. Restore it first.",
        )
    if folder.starred_at is None:
        folder.starred_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(folder)
    return _folder_to_response(folder, caller=user)


@router.delete("/folders/{folder_id}/star", response_model=FolderResponse)
async def unstar_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    folder = await _load_writable_folder(db, folder_id, user)
    folder.starred_at = None
    await db.commit()
    await db.refresh(folder)
    return _folder_to_response(folder, caller=user)


@router.get("/starred", response_model=StarredListResponse)
async def list_starred(
    scope: Scope = Query("mine"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StarredListResponse:
    folder_filter = and_(
        _owner_filter(user),
        FileFolder.starred_at.is_not(None),
        FileFolder.trashed_at.is_(None),
    )
    folder_rows = (
        (
            await db.execute(
                select(FileFolder)
                .where(folder_filter)
                .order_by(FileFolder.starred_at.desc())
            )
        )
        .scalars()
        .all()
    )

    file_filter = and_(
        _file_owner_filter(user),
        UserFile.starred_at.is_not(None),
        UserFile.trashed_at.is_(None),
        _drive_listing_filter(),
    )
    file_rows = (
        (
            await db.execute(
                select(UserFile)
                .where(file_filter)
                .order_by(UserFile.starred_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return StarredListResponse(
        folders=[_folder_to_response(f, caller=user) for f in folder_rows],
        files=[_file_to_response(f, caller=user) for f in file_rows],
    )


@router.get("/recent", response_model=RecentFilesResponse)
async def list_recent(
    scope: Scope = Query("mine"),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecentFilesResponse:
    """Most-recently-updated files, optionally scoped to shared.

    Relies on the ``updated_at`` trigger installed in migration
    0035 — every row mutation bumps it, so this feed also captures
    renames / moves / re-renders, not just fresh uploads.
    """
    file_filter = and_(
        _file_owner_filter(user),
        UserFile.trashed_at.is_(None),
        _drive_listing_filter(),
    )
    rows = (
        (
            await db.execute(
                select(UserFile)
                .where(file_filter)
                .order_by(UserFile.updated_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return RecentFilesResponse(files=[_file_to_response(f, caller=user) for f in rows])


# --------------------------------------------------------------------
# Drive stage 1 — Search (FTS)
# --------------------------------------------------------------------
@router.get("/search", response_model=FileSearchResponse)
async def search_files(
    q: str = Query(..., min_length=1, max_length=256),
    scope: Scope = Query("mine"),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileSearchResponse:
    """Full-text search over the caller's files.

    Uses ``websearch_to_tsquery`` so the query string accepts the
    familiar quote-phrase / ``-exclude`` / ``OR`` operators a user
    would already know from Google. ``ts_rank`` orders hits; the
    setweight (filename A, content B) applied in migration 0036
    means filename matches always beat content-only matches.

    Trashed rows are excluded so the search feels like "find a live
    file" instead of "find anything ever".
    """
    from sqlalchemy import literal, text as sql_text

    tsquery = sql_text("websearch_to_tsquery('english', :q)").bindparams(q=q)
    rank_expr = sql_text(
        "ts_rank(content_tsv, websearch_to_tsquery('english', :q))"
    ).bindparams(q=q)
    headline_expr = sql_text(
        "ts_headline('english', coalesce(content_text, filename), "
        "websearch_to_tsquery('english', :q), "
        "'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8, "
        "MaxFragments=1')"
    ).bindparams(q=q)

    tsv_match = sql_text("content_tsv @@ websearch_to_tsquery('english', :q)").bindparams(q=q)

    stmt = (
        select(UserFile, rank_expr.label("rank"), headline_expr.label("snippet"))
        .where(
            _file_owner_filter(user),
            UserFile.trashed_at.is_(None),
            _drive_listing_filter(),
            tsv_match,
        )
        .order_by(literal(None))  # placeholder, replaced below
        .limit(limit)
    )
    # Replace the placeholder order_by with our raw rank expression.
    stmt = stmt.order_by(None).order_by(
        sql_text(
            "ts_rank(content_tsv, websearch_to_tsquery('english', :q)) DESC"
        ).bindparams(q=q)
    )

    rows = (await db.execute(stmt)).all()

    hits: list[FileSearchHit] = []
    # Collect parent folder names in one lookup for the breadcrumb
    # strings — cheaper than one query per row.
    folder_ids = [r[0].folder_id for r in rows if r[0].folder_id is not None]
    folder_name_by_id: dict[uuid.UUID, str] = {}
    if folder_ids:
        folder_name_by_id = {
            fid: name
            for fid, name in (
                await db.execute(
                    select(FileFolder.id, FileFolder.name).where(
                        FileFolder.id.in_(folder_ids)
                    )
                )
            ).all()
        }

    for f, rank, snippet in rows:
        breadcrumb = None
        if f.folder_id and f.folder_id in folder_name_by_id:
            breadcrumb = folder_name_by_id[f.folder_id]
        hits.append(
            FileSearchHit(
                file=_file_to_response(f, caller=user),
                rank=float(rank or 0),
                snippet=snippet,
                breadcrumb=breadcrumb,
            )
        )

    return FileSearchResponse(query=q, hits=hits)


# --------------------------------------------------------------------
# Drive stage 5 — Peer-to-peer share grants
# --------------------------------------------------------------------
async def _resolve_grant_target(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
    caller: User,
) -> tuple[str, uuid.UUID]:
    """Owner-only guard for grant CRUD.

    Loads the underlying file/folder, asserts the caller owns it,
    and that it's eligible to be shared. Returns the (type, id)
    tuple normalised so the caller can use it directly when
    inserting into ``resource_grants``.
    """
    if resource_type == "folder":
        folder = await db.get(FileFolder, resource_id)
        if folder is None or folder.user_id != caller.id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Folder not found",
            )
        assert_folder_shareable(folder)
        return ("folder", folder.id)
    if resource_type == "file":
        row = await db.get(UserFile, resource_id)
        if row is None or row.user_id != caller.id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="File not found",
            )
        assert_file_shareable(row)
        return ("file", row.id)
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="resource_type must be 'file' or 'folder'",
    )


async def _grants_list_response(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
) -> GrantsListResponse:
    grants = await grants_for_resource(
        db, resource_type=resource_type, resource_id=resource_id
    )
    if not grants:
        return GrantsListResponse(grants=[], can_share=True)
    user_ids = {g.grantee_user_id for g in grants}
    rows = (
        await db.execute(select(User).where(User.id.in_(user_ids)))
    ).scalars().all()
    by_id = {u.id: u for u in rows}
    out: list = []
    for g in grants:
        u = by_id.get(g.grantee_user_id)
        if u is None:
            # User was deleted out from under us; the row will be
            # cascade-cleaned next time the FK fires, but we skip
            # it here so the modal doesn't render a ghost row.
            continue
        out.append(
            {
                "grant_id": g.id,
                "user_id": u.id,
                "username": u.username,
                "email": u.email,
                "can_copy": g.can_copy,
            }
        )
    return GrantsListResponse(
        grants=out,  # type: ignore[arg-type]
        can_share=True,
    )


@router.get("/users/search", response_model=UserSearchResponse)
async def search_users_for_share(
    q: str = Query(min_length=1, max_length=80),
    resource_type: str | None = Query(default=None),
    resource_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserSearchResponse:
    """Type-ahead user picker for the share modal.

    Matches by ``username`` or ``email`` (case-insensitive prefix).
    Excludes the caller themselves. When ``resource_type`` and
    ``resource_id`` are passed, marks rows that already have a
    grant on that resource so the picker can disable them.
    """
    needle = f"{q.lower()}%"
    rows = (
        await db.execute(
            select(User)
            .where(
                User.id != user.id,
                (
                    func.lower(User.username).like(needle)
                    | func.lower(User.email).like(needle)
                ),
            )
            .order_by(User.username.asc())
            .limit(10)
        )
    ).scalars().all()
    granted_ids: set[uuid.UUID] = set()
    if resource_type and resource_id:
        # No ownership check here — the search endpoint is read-only
        # and only the caller's own resources will produce grants
        # they care about. Matching against any resource_id is fine
        # because we're only marking pre-granted rows for UX.
        existing = (
            await db.execute(
                select(ResourceGrant.grantee_user_id).where(
                    ResourceGrant.resource_type == resource_type,
                    ResourceGrant.resource_id == resource_id,
                )
            )
        ).scalars().all()
        granted_ids = set(existing)
    return UserSearchResponse(
        results=[
            UserSearchResult(
                id=u.id,
                username=u.username,
                email=u.email,
                already_granted=u.id in granted_ids,
            )
            for u in rows
        ]
    )


@router.get(
    "/{resource_type}/{resource_id}/grants",
    response_model=GrantsListResponse,
)
async def list_grants(
    resource_type: str,
    resource_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GrantsListResponse:
    """List the active grants on a resource. Owner-only."""
    rt, rid = await _resolve_grant_target(
        db,
        resource_type=resource_type,
        resource_id=resource_id,
        caller=user,
    )
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


@router.post(
    "/{resource_type}/{resource_id}/grants",
    response_model=GrantsListResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_grant(
    resource_type: str,
    resource_id: uuid.UUID,
    payload: CreateGrantRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GrantsListResponse:
    rt, rid = await _resolve_grant_target(
        db,
        resource_type=resource_type,
        resource_id=resource_id,
        caller=user,
    )
    if payload.grantee_user_id == user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You can't grant access to yourself.",
        )
    grantee = await db.get(User, payload.grantee_user_id)
    if grantee is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    # Cap enforcement: refuse the 11th grant on a single resource.
    existing = await grants_for_resource(
        db, resource_type=rt, resource_id=rid
    )
    if len(existing) >= MAX_GRANTS_PER_RESOURCE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"This resource already has the maximum of "
                f"{MAX_GRANTS_PER_RESOURCE} grants. Revoke one before "
                f"adding another."
            ),
        )
    grant = ResourceGrant(
        resource_type=rt,
        resource_id=rid,
        grantee_user_id=grantee.id,
        granted_by_user_id=user.id,
        can_copy=payload.can_copy,
    )
    db.add(grant)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Unique-constraint violation = grantee already on the list.
        # Surface that as a friendly 409 instead of a 500.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That user already has access to this resource.",
        )
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


@router.patch(
    "/{resource_type}/{resource_id}/grants/{grant_id}",
    response_model=GrantsListResponse,
)
async def update_grant(
    resource_type: str,
    resource_id: uuid.UUID,
    grant_id: uuid.UUID,
    payload: UpdateGrantRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GrantsListResponse:
    rt, rid = await _resolve_grant_target(
        db,
        resource_type=resource_type,
        resource_id=resource_id,
        caller=user,
    )
    grant = await db.get(ResourceGrant, grant_id)
    if (
        grant is None
        or grant.resource_type != rt
        or grant.resource_id != rid
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found"
        )
    grant.can_copy = payload.can_copy
    await db.commit()
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


@router.delete(
    "/{resource_type}/{resource_id}/grants/{grant_id}",
    response_model=GrantsListResponse,
)
async def revoke_grant(
    resource_type: str,
    resource_id: uuid.UUID,
    grant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GrantsListResponse:
    rt, rid = await _resolve_grant_target(
        db,
        resource_type=resource_type,
        resource_id=resource_id,
        caller=user,
    )
    grant = await db.get(ResourceGrant, grant_id)
    if (
        grant is None
        or grant.resource_type != rt
        or grant.resource_id != rid
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found"
        )
    await db.delete(grant)
    await db.commit()
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


@router.delete(
    "/{resource_type}/{resource_id}/grants",
    response_model=GrantsListResponse,
)
async def revoke_all_grants(
    resource_type: str,
    resource_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GrantsListResponse:
    """Bulk 'Unshare' — drop every grant on this resource.

    Exposed so the "Stop sharing" button in the grants modal can do
    the nuclear option in a single round-trip instead of firing N
    DELETEs back to back. Owner-only (same guard as per-grant CRUD).
    Idempotent: returns an empty list whether or not anything was
    actually deleted, so the UI can just blindly refresh.
    """
    rt, rid = await _resolve_grant_target(
        db,
        resource_type=resource_type,
        resource_id=resource_id,
        caller=user,
    )
    await db.execute(
        sa_delete(ResourceGrant)
        .where(ResourceGrant.resource_type == rt)
        .where(ResourceGrant.resource_id == rid)
    )
    await db.commit()
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


# --------------------------------------------------------------------
# Drive stage 5 — Copy-to-my-files for grantees
# --------------------------------------------------------------------
@router.post(
    "/files/{file_id}/copy-to-mine",
    response_model=CopyToMineResponse,
    status_code=status.HTTP_201_CREATED,
)
async def copy_file_to_mine(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CopyToMineResponse:
    """Clone a shared file the caller has ``can_copy`` access to.

    Allowed paths:

    * Direct file grant with ``can_copy=true`` on this row.
    * Folder grant with ``can_copy=true`` on any ancestor folder.

    Owners are deliberately allowed too (it's a no-op-ish duplicate
    of their own file under the same name + " (copy)"), so the UI
    can show the affordance uniformly.

    The clone:

    * Lands in the caller's Drive root (``folder_id=None``).
    * Counts against the caller's storage quota.
    * Does not inherit any ``source_kind`` / ``source_file_id``
      provenance — it's an ordinary file from the recipient's
      perspective. This avoids surprising "edit source" affordances
      on the copy.
    * Has no grants of its own (recipient-owned, recipient-private
      until they explicitly share it).
    """
    src = await db.get(UserFile, file_id)
    if src is None or src.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )

    is_owner = src.user_id is not None and src.user_id == user.id
    if not is_owner:
        grants = await caller_grants_for_file(db, src, user)
        if not grants:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="File not found",
            )
        if not any(g.can_copy for g in grants):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "This file is shared read-only. Ask the owner for "
                    "copy access."
                ),
            )

    # Quota check before we touch the disk.
    quota = await get_quota(db, user)
    if not quota.can_fit(src.size_bytes):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Copying this file would exceed your storage quota.",
        )

    # New row + new blob path under the caller's bucket. Reuse the
    # source extension so the canonical mime survives the copy.
    new_id = uuid.uuid4()
    ext = os.path.splitext(src.storage_path)[1]
    rel_path = storage_path_for(user.id, new_id, ext)
    ensure_bucket(user.id)
    src_abs = absolute_path(src.storage_path)
    dest_abs = absolute_path(rel_path)
    dest_abs.parent.mkdir(parents=True, exist_ok=True)
    try:
        # ``shutil.copyfile`` keeps mtime alone (we want the new row
        # to look fresh anyway) and copies in 64K chunks under the
        # hood — fine for the 40 MB cap.
        from shutil import copyfile

        copyfile(src_abs, dest_abs)
    except (OSError, ValueError) as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to copy file blob: {e}",
        )

    # Pick a sensible filename. " (copy)" suffix mirrors the
    # standard cloud-drive convention.
    base, ext_part = os.path.splitext(src.filename)
    new_name = f"{base} (copy){ext_part}" if base else src.filename

    clone = UserFile(
        id=new_id,
        user_id=user.id,
        folder_id=None,
        filename=new_name,
        original_filename=src.original_filename,
        mime_type=src.mime_type,
        size_bytes=src.size_bytes,
        storage_path=rel_path,
        # Provenance reset: copies are ordinary user uploads from
        # the recipient's POV. ``content_text`` is copied so FTS
        # works on the clone too without re-extraction.
        content_text=src.content_text,
    )
    db.add(clone)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Roll back the on-disk write before re-raising.
        try:
            dest_abs.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A file with this name already exists in your Drive root.",
        )
    await db.refresh(clone)
    return CopyToMineResponse(
        file=_file_to_response(clone, caller=user),
    )


# --------------------------------------------------------------------
# Drive stage 1 — Share links (owner side, authenticated)
# --------------------------------------------------------------------
def _link_to_response(link: FileShareLink) -> ShareLinkResponse:
    return ShareLinkResponse(
        id=link.id,
        resource_type=link.resource_type,  # type: ignore[arg-type]
        resource_id=link.resource_id,
        token=link.token,
        access_mode=link.access_mode,  # type: ignore[arg-type]
        has_password=link.password_hash is not None,
        expires_at=link.expires_at,
        revoked_at=link.revoked_at,
        access_count=link.access_count,
        last_accessed_at=link.last_accessed_at,
        created_at=link.created_at,
        path=f"/s/{link.token}",
    )


async def _assert_share_owner_of_file(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> UserFile:
    """Owner-only guard for share-link CRUD.

    Shared-pool files can only be link-shared by admins. Private
    pool files can only be link-shared by the owner. Project
    collaborators *cannot* mint new links for a file someone else
    pinned — that surface is deliberately owner-only so revocation
    stays meaningful.
    """
    row = await db.get(UserFile, file_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )
    if row.user_id is None or row.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the file owner can manage share links",
        )
    if row.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't share a trashed file. Restore it first.",
        )
    return row


async def _assert_share_owner_of_folder(
    db: AsyncSession, folder_id: uuid.UUID, user: User
) -> FileFolder:
    folder = await db.get(FileFolder, folder_id)
    if folder is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )
    if folder.user_id is None or folder.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the folder owner can manage share links",
        )
    if folder.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't share a trashed folder. Restore it first.",
        )
    return folder


async def _create_share_link(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
    created_by: uuid.UUID,
    payload: ShareLinkCreateRequest,
) -> FileShareLink:
    from app.auth.utils import hash_password

    expires_at: datetime | None = None
    if payload.expires_in_days is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(
            days=payload.expires_in_days
        )
    password_hash = hash_password(payload.password) if payload.password else None

    link = FileShareLink(
        resource_type=resource_type,
        resource_id=resource_id,
        created_by=created_by,
        # 32 bytes of CSPRNG entropy → ~256 bits. Unique constraint on
        # the column + retries handled implicitly by the DB (we just
        # raise on collision, which is astronomically improbable).
        token=_secrets.token_urlsafe(32),
        access_mode=payload.access_mode,
        password_hash=password_hash,
        expires_at=expires_at,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    return link


@router.post(
    "/{file_id}/share-links",
    response_model=ShareLinkResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_file_share_link(
    file_id: uuid.UUID,
    payload: ShareLinkCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ShareLinkResponse:
    row = await _assert_share_owner_of_file(db, file_id, user)
    link = await _create_share_link(
        db,
        resource_type="file",
        resource_id=row.id,
        created_by=user.id,
        payload=payload,
    )
    return _link_to_response(link)


@router.post(
    "/folders/{folder_id}/share-links",
    response_model=ShareLinkResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_folder_share_link(
    folder_id: uuid.UUID,
    payload: ShareLinkCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ShareLinkResponse:
    folder = await _assert_share_owner_of_folder(db, folder_id, user)
    _assert_not_system_folder(folder, "share")
    link = await _create_share_link(
        db,
        resource_type="folder",
        resource_id=folder.id,
        created_by=user.id,
        payload=payload,
    )
    return _link_to_response(link)


async def _list_share_links(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
) -> list[FileShareLink]:
    rows = (
        (
            await db.execute(
                select(FileShareLink)
                .where(
                    FileShareLink.resource_type == resource_type,
                    FileShareLink.resource_id == resource_id,
                )
                .order_by(FileShareLink.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


@router.get(
    "/{file_id}/share-links", response_model=ShareLinkListResponse
)
async def list_file_share_links(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ShareLinkListResponse:
    row = await _assert_share_owner_of_file(db, file_id, user)
    rows = await _list_share_links(
        db, resource_type="file", resource_id=row.id
    )
    return ShareLinkListResponse(links=[_link_to_response(r) for r in rows])


@router.get(
    "/folders/{folder_id}/share-links", response_model=ShareLinkListResponse
)
async def list_folder_share_links(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ShareLinkListResponse:
    folder = await _assert_share_owner_of_folder(db, folder_id, user)
    rows = await _list_share_links(
        db, resource_type="folder", resource_id=folder.id
    )
    return ShareLinkListResponse(links=[_link_to_response(r) for r in rows])


@router.delete(
    "/share-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def revoke_share_link(
    link_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    link = await db.get(FileShareLink, link_id)
    if link is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found"
        )
    # Only the link creator (or an admin) can revoke. We don't want
    # a project-share collaborator revoking the link the owner
    # minted.
    if link.created_by != user.id and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the link creator can revoke it",
        )
    if link.revoked_at is None:
        link.revoked_at = datetime.now(timezone.utc)
        await db.commit()
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
        # Drive stage 1: trashed rows are invisible to the chat
        # attach flow. Treat them as "not found" rather than 403
        # so a stale message-compose path gets a clear "Unknown
        # attachment" error.
        if (
            row is None
            or row.trashed_at is not None
            or row.user_id is None
            or row.user_id != user.id
        ):
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

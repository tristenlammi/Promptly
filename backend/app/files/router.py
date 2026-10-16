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

import asyncio
import logging
import mimetypes
import os
import re
import secrets as _secrets
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import Any, Iterable

from fastapi import (
    APIRouter,
    BackgroundTasks,
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
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from sqlalchemy import and_, delete as sa_delete, func, nullslast, or_, select
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
    OwnedShareLink,
    OwnedShareLinksResponse,
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
from app.files.disk_guard import require_disk_room
from app.files.purge import purge_file_rows as _purge_file_rows
from app.files.purge import purge_folder_subtree as _purge_folder_subtree
from app.files.system_folders import (
    SystemKind,
    camera_month_folder,
    folder_for_chat_upload,
    folder_for_generated,
)
from app.files.storage import (
    MAX_FILE_BYTES,
    absolute_path,
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
        hide_from_photos=bool(getattr(folder, "hide_from_photos", False)),
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
        # "Modified" is a content date — a star or move no longer changes it
        # (R-209).
        updated_at=f.modified_at or f.updated_at,
        modified_at=f.modified_at or f.updated_at,
        starred_at=f.starred_at,
        trashed_at=f.trashed_at,
        source_kind=f.source_kind,
        sharing=sharing,
        source_file_id=f.source_file_id,
        blob_state=getattr(f, "blob_state", None) or "ready",
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


async def fill_thumbhashes(db: AsyncSession, files: list[FileResponse], user: User | None = None) -> None:
    """Put each photo's / video's ThumbHash on its listing row (WP-7.4) —
    the grid draws the blurred placeholder while the thumbnail loads — and,
    for ``user``, a signed link to its WebP tile (WP-7.5)."""
    from app.files import media_urls
    from app.files.models import FileMedia

    ids = [f.id for f in files if (f.mime_type or "").startswith(("image/", "video/"))]
    if not ids:
        return
    rows = {
        fid: (thumbhash, state, renditions)
        for fid, thumbhash, state, renditions in (await db.execute(
            select(FileMedia.file_id, FileMedia.thumbhash, FileMedia.derivative_state, FileMedia.renditions)
            .where(FileMedia.file_id.in_(ids))
        )).all()
    }
    for f in files:
        thumbhash, state, renditions = rows.get(f.id, (None, None, None))
        f.thumbhash = thumbhash
        if user is not None and state == "ready":
            f.thumb_url = media_urls.sign_shown(f.id, user.id, user.token_version, renditions, "thumb")


def client_mtime_from(ms: int | None) -> datetime | None:
    """``File.lastModified`` (ms) → a datetime, if it's believable (after
    1990, not in the future)."""
    if ms is None:
        return None
    try:
        dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    if dt.year < 1990 or dt > datetime.now(timezone.utc) + timedelta(days=1):
        return None
    return dt


async def lock_owner_quota(db: AsyncSession, owner_id: uuid.UUID) -> None:
    """Serialise the final quota check + insert of one owner's uploads
    (a transaction-scoped advisory lock — released at commit / rollback)."""
    from sqlalchemy import text as _text

    key = owner_id.int & 0x7FFF_FFFF_FFFF_FFFF
    await db.execute(_text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


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
    # Owner, a direct grant, or a grant on any folder above it — the same
    # rule AI search uses to decide what you can find (WP-5.1). Trashed
    # files stay openable here (the trash view), as before.
    from app.files.access import can_read

    if await can_read(db, row.id, user.id, include_trashed=True):
        return row
    # Workspace-share side-door: a collaborator on a shared workspace
    # can read any file pinned to that workspace (including files
    # owned by the workspace creator or other collaborators). Without
    # this path the chat-preamble download links inside a shared
    # workspace 404 for anyone but the pin's original owner.
    if await _file_is_accessible_via_workspace(db, row.id, user):
        return row
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
    )


async def _file_is_accessible_via_workspace(
    db: AsyncSession, file_id: uuid.UUID, user: User
) -> bool:
    """Does ``user`` reach ``file_id`` through a shared workspace?

    Thin wrapper over the canonical helper in ``app.files.sharing`` so
    the files router and the documents router share one definition of
    workspace reachability (pinned file / note-or-file item / canvas
    backing text) rather than drifting copies.
    """
    from app.files.sharing import file_is_accessible_via_workspace

    return await file_is_accessible_via_workspace(db, file_id, user)


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

    from app.files.generated_kinds import HIDDEN_KINDS

    return or_(
        UserFile.source_kind.is_(None),
        UserFile.source_kind.not_in(sorted(HIDDEN_KINDS)),
    )


def _non_system_folder_filter(user: User):
    """Exclude files sitting directly inside a system-managed folder.

    The ``@``-mention picker uses this so it only surfaces files the
    user actually filed themselves — never the Chat Uploads bucket
    (which fills with re-attached résumés etc.), the Generated
    Files/Media buckets, or the Workspaces root. Root-level files
    (``folder_id`` NULL) always pass; only immediate children of a
    ``system_kind``-tagged folder are filtered out (Chat Uploads is
    flat and Generated's leaves are themselves system folders, so this
    catches everything without a recursive walk).
    """
    from sqlalchemy import or_

    system_folder_ids = select(FileFolder.id).where(
        FileFolder.user_id == user.id,
        FileFolder.system_kind.is_not(None),
    )
    return or_(
        UserFile.folder_id.is_(None),
        UserFile.folder_id.not_in(system_folder_ids),
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
_SORT_KEYS = ("name", "modified", "size")


def _folder_order(sort: str, direction: str):
    """ORDER BY clause for folder rows. Folders have no size, so a
    ``size`` sort falls back to name for them (files still sort by size)."""
    col = {
        "name": FileFolder.name,
        "modified": FileFolder.updated_at,
        "size": FileFolder.name,
    }.get(sort, FileFolder.name)
    return nullslast(col.desc() if direction == "desc" else col.asc())




def _file_sort_key(sort: str):
    """The column a file listing is ordered (and paged) by, and how to read
    that value off a row."""
    if sort == "modified":
        return UserFile.modified_at, lambda f: f.modified_at
    if sort == "size":
        return UserFile.size_bytes, lambda f: f.size_bytes
    return UserFile.filename, lambda f: f.filename


@dataclass(frozen=True)
class _Page:
    """One page of a listing (WP-7.6): ``limit`` None = everything."""
    limit: int | None = None
    after: Any = None
    folders_only: bool = False


@router.get("/browse", response_model=BrowseResponse)
async def browse(
    scope: Scope = Query("mine"),
    folder_id: uuid.UUID | None = Query(default=None),
    sort: str = Query("name"),
    direction: str = Query("asc", alias="dir"),
    # Shared root only (WP-3.5): "with_me" — what others shared with you
    # (the default view); "by_me" — your own items with a grant or a live
    # link; "all" — both, as before.
    shared: str = Query("all", pattern="^(all|with_me|by_me)$"),
    # Pages (WP-7.6): up to ``limit`` files, then ``next_cursor``. Without a
    # limit, everything (as before).
    limit: int | None = Query(default=None, ge=1, le=1000),
    cursor: str | None = Query(default=None),
    # Just the subfolders — the folder tree and the Move picker (WP-7.6).
    folders_only: bool = Query(default=False),
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

    # Normalise the sort knobs defensively so a stale/hostile client
    # can't reach the ORDER BY with a bad column name.
    sort = sort if sort in _SORT_KEYS else "name"
    direction = "desc" if direction == "desc" else "asc"
    from app.files import paging

    page = _Page(limit=limit, after=paging.decode(cursor, sort, direction), folders_only=folders_only)

    if scope == "mine":
        resp = await _browse_mine(db, user, parent, sort, direction, page)
    else:
        resp = await _browse_shared(db, user, parent, shared=shared, sort=sort, direction=direction, page=page)
    await fill_thumbhashes(db, resp.files, user)
    return resp


@router.get("/folders", response_model=BrowseResponse)
async def list_subfolders(
    scope: Scope = Query("mine"),
    parent_id: uuid.UUID | None = Query(default=None),
    shared: str = Query("all", pattern="^(all|with_me|by_me)$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> BrowseResponse:
    """A folder's subfolders, without its files (WP-7.6) — what the folder
    tree and the Move picker need, at a fraction of a full listing."""
    return await browse(
        scope=scope, folder_id=parent_id, sort="name", direction="asc", shared=shared,
        limit=None, cursor=None, folders_only=True, db=db, user=user,
    )


async def _browse_mine(
    db: AsyncSession,
    user: User,
    parent: FileFolder | None,
    sort: str = "name",
    direction: str = "asc",
    page: _Page = _Page(),
) -> BrowseResponse:
    from app.files import paging

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
    # Folders come with the first page only.
    folder_rows = [] if page.after is not None else (
        await db.execute(
            select(FileFolder)
            .where(folder_filter)
            .order_by(_folder_order(sort, direction), FileFolder.id)
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
    file_rows: list[UserFile] = []
    next_cursor = None
    if not page.folders_only:
        col, value_of = _file_sort_key(sort)
        rows = (
            await db.execute(paging.apply(select(UserFile).where(file_filter), col, UserFile.id, direction, page.after, page.limit))
        ).scalars().all()
        file_rows, next_cursor = paging.split(rows, page.limit, sort, direction, value_of)

    file_summaries, folder_summaries = await bulk_summaries(
        db,
        files=list(file_rows),
        folders=list(folder_rows),
        caller=user,
    )

    owner = (
        await _owning_workspace(db, parent.id, await _workspace_roots(db)) if parent else None
    )
    return BrowseResponse(
        scope="mine",
        workspace_id=owner[0] if owner else None,
        workspace_title=owner[1] if owner else None,
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
        next_cursor=next_cursor,
    )


async def _browse_shared(
    db: AsyncSession, user: User, parent: FileFolder | None, *, shared: str = "all",
    sort: str = "name", direction: str = "asc", page: _Page = _Page(),
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
        return await _shared_root(db, user, shared=shared, sort=sort, direction=direction, page=page)
    return await _shared_inside(db, user, parent, sort=sort, direction=direction, page=page)


async def _shared_root(
    db: AsyncSession, user: User, *, shared: str = "all",
    sort: str = "name", direction: str = "asc", page: _Page = _Page(),
) -> BrowseResponse:
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

    # "By me" also counts your items that only have a live public link.
    if shared != "with_me":
        from app.files.models import FileShareLink

        now = datetime.now(timezone.utc)
        linked = (
            await db.execute(
                select(FileShareLink.resource_type, FileShareLink.resource_id).where(
                    FileShareLink.created_by == user.id,
                    FileShareLink.revoked_at.is_(None),
                    or_(FileShareLink.expires_at.is_(None), FileShareLink.expires_at > now),
                )
            )
        ).all()
        have_files = {f.id for f in owned_shared_files}
        have_folders = {f.id for f in owned_shared_folders}
        link_file_ids = [rid for rt, rid in linked if rt == "file" and rid not in have_files]
        link_folder_ids = [rid for rt, rid in linked if rt == "folder" and rid not in have_folders]
        if link_file_ids:
            owned_shared_files += list(
                (
                    await db.execute(
                        select(UserFile).where(
                            UserFile.id.in_(link_file_ids),
                            UserFile.user_id == user.id,
                            UserFile.trashed_at.is_(None),
                            _drive_listing_filter(),
                        )
                    )
                ).scalars()
            )
        if link_folder_ids:
            owned_shared_folders += list(
                (
                    await db.execute(
                        select(FileFolder).where(
                            FileFolder.id.in_(link_folder_ids),
                            FileFolder.user_id == user.id,
                            FileFolder.trashed_at.is_(None),
                        )
                    )
                ).scalars()
            )
    if shared == "with_me":
        owned_shared_folders, owned_shared_files = [], []
    elif shared == "by_me":
        grantee_folders, grantee_files = [], []

    # Merge + de-dupe (an owner who's also a grantee on someone
    # else's grant of their own row shouldn't ever happen, but
    # defensively...).
    folders_by_id: dict[uuid.UUID, FileFolder] = {}
    for f in grantee_folders + owned_shared_folders:
        folders_by_id[f.id] = f
    files_by_id: dict[uuid.UUID, UserFile] = {}
    for f in grantee_files + owned_shared_files:
        files_by_id[f.id] = f

    from app.files import paging

    folder_list = [] if page.after is not None else sorted(folders_by_id.values(), key=lambda f: f.name.lower())
    file_list: list[UserFile] = []
    next_cursor = None
    if not page.folders_only:
        _col, value_of = _file_sort_key(sort)
        key = (lambda f: f.filename.lower()) if sort == "name" else value_of
        file_list, next_cursor = paging.in_memory(
            list(files_by_id.values()), key, direction, page.after, page.limit, sort
        )

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
        next_cursor=next_cursor,
    )


async def _shared_inside(
    db: AsyncSession, user: User, parent: FileFolder, *,
    sort: str = "name", direction: str = "asc", page: _Page = _Page(),
) -> BrowseResponse:
    from app.files import paging

    # Direct children only — folder grants cascade so descendants
    # of ``parent`` are readable too.
    folder_rows = [] if page.after is not None else (
        await db.execute(
            select(FileFolder)
            .where(
                FileFolder.parent_id == parent.id,
                FileFolder.trashed_at.is_(None),
            )
            .order_by(_folder_order(sort, direction), FileFolder.id)
        )
    ).scalars().all()
    file_rows: list[UserFile] = []
    next_cursor = None
    if not page.folders_only:
        col, value_of = _file_sort_key(sort)
        stmt = select(UserFile).where(
            UserFile.folder_id == parent.id,
            UserFile.trashed_at.is_(None),
            _drive_listing_filter(),
        )
        rows = (await db.execute(paging.apply(stmt, col, UserFile.id, direction, page.after, page.limit))).scalars().all()
        file_rows, next_cursor = paging.split(rows, page.limit, sort, direction, value_of)

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
        next_cursor=next_cursor,
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
class FlatFolder(BaseModel):
    """Minimal folder row for flat pickers (automation folder filters)."""

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str


@router.get("/folders/all", response_model=list[FlatFolder])
async def list_all_folders(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[FlatFolder]:
    """Every live folder in the caller's *personal* Drive as a flat list —
    used by pickers that need the whole tree at once (e.g. the automation
    event-trigger folder filter). Excludes the trash and the system-managed
    ``Workspaces`` subtree (workspace drives have their own picker)."""
    rows = list(
        (
            await db.execute(
                select(FileFolder).where(
                    FileFolder.user_id == user.id,
                    FileFolder.trashed_at.is_(None),
                )
            )
        ).scalars()
    )
    # Drop the Workspaces root and everything beneath it.
    ws_roots = {
        f.id for f in rows if f.system_kind == SystemKind.WORKSPACES_ROOT.value
    }
    excluded: set[uuid.UUID] = set(ws_roots)
    if ws_roots:
        changed = True
        while changed:
            changed = False
            for f in rows:
                if f.id not in excluded and f.parent_id in excluded:
                    excluded.add(f.id)
                    changed = True
    keep = [f for f in rows if f.id not in excluded]
    keep.sort(key=lambda f: f.name.lower())
    return [
        FlatFolder(id=f.id, parent_id=f.parent_id, name=f.name) for f in keep
    ]


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


# --------------------------------------------------------------------
# Workspace-owned folders (R-215)
# --------------------------------------------------------------------
# A workspace keeps its notes, canvases and uploads under
# ``Workspaces/<title>/{Notes,Canvases,Files}`` in its owner's Drive. Those
# looked like ordinary folders: trashing one from Drive silently broke the
# workspace's items (and emptying the trash destroyed them). Drive now
# leaves them to the workspace.


async def _workspace_roots(db: AsyncSession) -> dict[uuid.UUID, tuple[uuid.UUID, str]]:
    from app.chat.models import Workspace

    rows = (
        await db.execute(
            select(Workspace.root_folder_id, Workspace.id, Workspace.title).where(
                Workspace.root_folder_id.is_not(None)
            )
        )
    ).all()
    return {r[0]: (r[1], r[2]) for r in rows}


async def _owning_workspace(
    db: AsyncSession, folder_id: uuid.UUID | None, roots: dict
) -> tuple[uuid.UUID, str, int] | None:
    """(workspace id, title, depth) when ``folder_id`` is a workspace's
    folder (depth 0) or inside one; None otherwise."""
    cur = folder_id
    depth = 0
    for _ in range(64):
        if cur is None:
            return None
        if cur in roots:
            ws_id, title = roots[cur]
            return ws_id, title, depth
        f = await db.get(FileFolder, cur)
        if f is None:
            return None
        cur = f.parent_id
        depth += 1
    return None


def _workspace_conflict(title: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"This belongs to the workspace “{title}”. Rename, move or delete it "
            "from the workspace instead."
        ),
    )


async def _guard_workspace_folder(db: AsyncSession, folder: FileFolder, roots=None) -> None:
    """A workspace's own folder and its Notes / Canvases / Files can't be
    renamed, moved or trashed from Drive. Folders a user made deeper inside
    stay theirs to manage."""
    roots = roots if roots is not None else await _workspace_roots(db)
    owner = await _owning_workspace(db, folder.id, roots)
    if owner is not None and owner[2] <= 1:
        raise _workspace_conflict(owner[1])


async def _guard_workspace_file(db: AsyncSession, row: UserFile, roots=None) -> None:
    """A file in a workspace's folders backs a workspace item (a note, a
    canvas's text, a pinned upload) — Drive can't trash, rename or move it
    out from under the workspace."""
    roots = roots if roots is not None else await _workspace_roots(db)
    owner = await _owning_workspace(db, row.folder_id, roots)
    if owner is not None:
        raise _workspace_conflict(owner[1])


async def _in_workspace_tree(db: AsyncSession, folder_id, roots) -> bool:
    return await _owning_workspace(db, folder_id, roots) is not None


@router.patch("/folders/{folder_id:uuid}", response_model=FolderResponse)
async def update_folder(
    folder_id: uuid.UUID,
    payload: FolderUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    folder = await _load_writable_folder(db, folder_id, user)
    if payload.name is not None or payload.parent_id is not None or payload.move_to_root:
        await _guard_workspace_folder(db, folder)

    if payload.name is not None:
        _assert_not_system_folder(folder, "rename")
        folder.name = payload.name.strip()
    if payload.hide_from_photos is not None:
        folder.hide_from_photos = payload.hide_from_photos

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


@router.delete("/folders/{folder_id:uuid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete a folder subtree (kept for older clients; the
    Trash page uses ``POST /bulk/purge``).

    Used to delete only the folder rows and unlink every blob underneath,
    while the file rows survived (``folder_id`` is SET NULL) — leaving
    restorable files that could never be opened and still counted against
    quota (R-025). Now the subtree's files go with it, through the same
    deferred-deletion path as everything else.
    """
    folder = await _load_writable_folder(db, folder_id, user)
    _assert_not_system_folder(folder, "delete")
    await _guard_workspace_folder(db, folder)
    await _purge_folder_subtree(db, folder)
    await db.commit()
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


async def _free_file_name(
    db: AsyncSession, owner_id: uuid.UUID, folder: FileFolder | None, name: str
) -> str:
    """``name``, or "stem (1).ext", "(2)"… — the first not taken by a live
    file in ``folder``."""
    taken = {
        n.lower()
        for n in (
            await db.execute(
                select(UserFile.filename).where(
                    UserFile.user_id == owner_id,
                    UserFile.folder_id == folder.id if folder is not None else UserFile.folder_id.is_(None),
                    UserFile.trashed_at.is_(None),
                )
            )
        ).scalars()
    }
    stem, ext = os.path.splitext(name)
    n = 1
    candidate = name
    while candidate.lower() in taken:
        candidate = f"{stem} ({n}){ext}"
        n += 1
    return candidate


@router.get("/upload-policy")
async def upload_policy(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """What an upload may be — so the client can refuse a file before
    sending 100 MB only to have it rejected (R-212) — and, when tusd runs,
    where bigger files go, resumably (WP-8.2)."""
    from app.config import get_settings
    from app.files.safety import _ALLOWED_EXTS
    from app.files.tus_hooks import large_max_bytes

    cfg = get_settings()
    return {
        "max_bytes": MAX_FILE_BYTES,
        "allowed_extensions": sorted(_ALLOWED_EXTS),
        "tus_endpoint": "/api/files/tus/" if cfg.TUS_ENABLED else None,
        "tus_threshold": cfg.TUS_THRESHOLD_BYTES,
        "large_max_bytes": await large_max_bytes(db) if cfg.TUS_ENABLED else MAX_FILE_BYTES,
    }


class _PrecheckFile(BaseModel):
    name: str = Field(max_length=512)
    size: int = Field(ge=0)


class _Precheck(BaseModel):
    scope: Scope = "mine"
    folder_id: uuid.UUID | None = None
    workspace_id: uuid.UUID | None = None
    files: list[_PrecheckFile] = Field(max_length=5000)


@router.post("/precheck")
async def upload_precheck(
    payload: _Precheck,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Which of these are maybe already there (WP-8.2): for each file with
    a same-name, same-size file in the target folder, that file's SHA-256 —
    the client hashes just those and skips the identical ones."""
    owner_id: uuid.UUID | None = _owner_for_scope(user, payload.scope)
    folder_id: uuid.UUID | None = payload.folder_id
    if payload.workspace_id is not None:
        from app.workspaces.drive_router import workspace_upload_target

        target = await workspace_upload_target(db, payload.workspace_id, user, payload.folder_id)
        owner_id, folder_id = target.owner.id, target.folder.id
    elif folder_id is not None:
        await _load_writable_folder(db, folder_id, user)
    if owner_id is None or not payload.files:
        return {"matches": {}}
    names = {f.name.lower() for f in payload.files}
    rows = (
        await db.execute(
            select(UserFile.filename, UserFile.size_bytes, UserFile.content_sha256).where(
                UserFile.user_id == owner_id,
                UserFile.folder_id == folder_id if folder_id is not None else UserFile.folder_id.is_(None),
                UserFile.trashed_at.is_(None),
                UserFile.content_sha256.is_not(None),
                func.lower(UserFile.filename).in_(names),
            )
        )
    ).all()
    have = {(name.lower(), size): sha for name, size, sha in rows}
    matches = {
        str(i): have[(f.name.lower(), f.size)]
        for i, f in enumerate(payload.files)
        if (f.name.lower(), f.size) in have
    }
    return {"matches": matches}


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
        office_pending_bytes=quota.office_pending_bytes,
    )


@router.post("/", response_model=FileResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    request: Request,
    file: UploadFile,
    background: BackgroundTasks,
    scope: Scope = Form("mine"),
    folder_id: uuid.UUID | None = Form(default=None),
    # Optional auto-routing hint: when the caller doesn't specify
    # ``folder_id`` and ``scope == "mine"``, the upload is dropped into
    # the matching system folder. Today only ``"chat"`` is wired up;
    # ``"generated"`` is reserved for a future "AI made this for you"
    # flow and will route by MIME type.
    route: str | None = Form(default=None),
    # Same name already in the folder (R-212): "allow" (the old behaviour,
    # a duplicate), "ask" (409 ``name_exists`` before any bytes are
    # written, so the client can offer Replace / Keep both), "keep_both"
    # ("name (1).ext") or "replace" (the old file goes to the trash).
    on_conflict: str = Form(default="allow", pattern="^(allow|ask|keep_both|replace)$"),
    # The file's modified time on the uploading device, ms since the epoch
    # (``File.lastModified``) — a photo's fallback "taken" date (WP-7.3).
    last_modified: int | None = Form(default=None),
    # Into a workspace's drive (WP-7.6): editors upload there; the bytes are
    # the workspace owner's (their quota, their tree), and the file is
    # pinned to the workspace and indexed. ``folder_id`` is then a folder in
    # that drive (default: its root).
    workspace_id: uuid.UUID | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),
) -> FileResponse:
    return await _upload_core(
        db, request=request, user=user, background=background, filename=file.filename,
        declared_mime=file.content_type, scope=scope, folder_id=folder_id, route=route,
        on_conflict=on_conflict, workspace_id=workspace_id, last_modified=last_modified, upload=file,
    )


@dataclass(frozen=True)
class UploadPlan:
    """What a resumable upload was cleared for (WP-8.2)."""

    clean_name: str
    owner_id: uuid.UUID | None
    quota_user: User


async def plan_upload(
    db: AsyncSession, *, request: Request, user: User, size_hint: int | None, filename: str,
    declared_mime: str | None, scope: str, folder_id: uuid.UUID | None, route: str | None,
    on_conflict: str, workspace_id: uuid.UUID | None, last_modified: int | None,
) -> UploadPlan:
    """Every check an upload gets before its bytes arrive (name, folder,
    workspace, a clash to ask about, storage) — the tus pre-create hook."""
    return await _upload_core(
        db, request=request, user=user, background=None, filename=filename, declared_mime=declared_mime,
        scope=scope, folder_id=folder_id, route=route, on_conflict=on_conflict, workspace_id=workspace_id,
        last_modified=last_modified, check_size=size_hint or 0,
    )


async def ingest_staged(
    db: AsyncSession, *, request: Request, user: User, staged, filename: str,  # noqa: ANN001 — blobstore.Staged
    declared_mime: str | None, scope: str, folder_id: uuid.UUID | None, route: str | None,
    on_conflict: str, workspace_id: uuid.UUID | None, last_modified: int | None,
    replace_row: UserFile | None = None, version_source: str = "upload", allow_empty: bool = False,
    exact_folder: bool = False,
) -> FileResponse:
    """A finished resumable upload (or a WebDAV PUT), already staged: the
    rest of the one upload path (sniff, quota, file it or version it…).
    ``replace_row`` names the exact file the bytes replace (WebDAV knows it
    by its path); ``allow_empty`` lets a 0-byte file in (Finder makes one
    before it writes the content)."""
    return await _upload_core(
        db, request=request, user=user, background=None, filename=filename, declared_mime=declared_mime,
        scope=scope, folder_id=folder_id, route=route, on_conflict=on_conflict, workspace_id=workspace_id,
        last_modified=last_modified, staged_in=staged, replace_row=replace_row,
        version_source=version_source, allow_empty=allow_empty, exact_folder=exact_folder,
    )


async def _already_in_camera_uploads(db: AsyncSession, user: User, sha256: str) -> UserFile | None:
    """A live file in the user's Camera Uploads with these exact bytes."""
    from app.files.system_folders import SystemKind

    root = (
        await db.execute(
            select(FileFolder.id).where(
                FileFolder.user_id == user.id, FileFolder.system_kind == SystemKind.CAMERA_UPLOADS.value
            )
        )
    ).scalar_one_or_none()
    if root is None:
        return None
    ids = await _descendant_folder_ids(db, root)
    return (
        await db.execute(
            select(UserFile).where(
                UserFile.user_id == user.id, UserFile.folder_id.in_(ids),
                UserFile.content_sha256 == sha256, UserFile.trashed_at.is_(None),
            ).limit(1)
        )
    ).scalar_one_or_none()


async def _taken_or_modified(path, mime: str, last_modified: int | None, zone=None) -> datetime:  # noqa: ANN001
    """When a photo or video was taken (its metadata), else the device's
    modified time, else now — which month it's filed under. Without the
    photo's own offset, the month is the owner's (``zone``), as Photos
    shows it."""
    from app.files.media_meta import media_kind, read_tags, taken_from_tags

    if media_kind(mime) is not None:
        try:
            found = taken_from_tags(await asyncio.to_thread(read_tags, str(path)))
        except Exception:  # noqa: BLE001 — a date to file it under, never a reason to fail
            found = None
        if found is not None:
            dt, _source, offset = found
            # The month on the camera's clock, where it was taken.
            if offset is not None:
                return dt.astimezone(timezone(timedelta(minutes=offset)))
            # A camera's clock with no zone is already the wall time; a
            # QuickTime CreateDate is UTC.
            return dt.astimezone(zone) if zone is not None and _source != "exif" else dt
    when = client_mtime_from(last_modified) or datetime.now(timezone.utc)
    return when.astimezone(zone) if zone is not None else when


async def _upload_core(
    db: AsyncSession,
    *,
    request: Request,
    user: User,
    background: BackgroundTasks | None,
    filename: str | None,
    declared_mime: str | None,
    scope: str,
    folder_id: uuid.UUID | None,
    route: str | None,
    on_conflict: str,
    workspace_id: uuid.UUID | None,
    last_modified: int | None,
    upload: UploadFile | None = None,
    staged_in=None,  # noqa: ANN001 — blobstore.Staged
    check_size: int | None = None,
    replace_row: UserFile | None = None,
    version_source: str = "upload",
    allow_empty: bool = False,
    exact_folder: bool = False,
):
    """The one upload path (multipart, tus, a workspace's drive): see the
    numbered steps. ``check_size`` stops after the checks (a tus
    pre-create) and returns an :class:`UploadPlan`; ``staged_in`` starts
    from bytes already staged (a finished tus upload)."""

    async def _close() -> None:
        if upload is not None:
            await upload.close()

    owner_id = _owner_for_scope(user, scope)

    parent_folder: FileFolder | None = None
    ws_target = None
    quota_user = user
    if workspace_id is not None:
        from app.workspaces.drive_router import workspace_upload_target

        ws_target = await workspace_upload_target(db, workspace_id, user, folder_id)
        owner_id = ws_target.owner.id
        quota_user = ws_target.owner
        parent_folder = ws_target.folder
        route = None
    elif folder_id is not None:
        # ``_load_writable_folder`` enforces caller-owns the folder.
        # Uploads always land in the caller's own pool — sharing
        # is granted afterwards by the share-modal flow.
        parent_folder = await _load_writable_folder(db, folder_id, user)
        if parent_folder.system_kind == "camera_uploads" and not exact_folder and replace_row is None:
            # Into Camera Uploads itself: sorted by date like a phone
            # backup (WP-8.5). WebDAV keeps the exact path it was given.
            parent_folder, route = None, "camera"
    # If ``route`` requested an auto-routed destination we resolve it
    # *after* every validation step has passed (see step 7b below) so a
    # rejected upload doesn't leave an empty system folder behind.

    # ----- 1) Sanitise filename + extension allowlist -----
    # Done up front, before we ever touch the disk, so a hostile
    # filename can't even create a transient file inside the upload
    # bucket.
    try:
        clean_name = sanitize_filename(filename)
    except UnsafeUploadError as e:
        await _audit_upload_rejection(
            db,
            request=request,
            user=user,
            code=e.code,
            declared_filename=filename,
        )
        await _close()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    ext = os.path.splitext(clean_name)[1].lower()

    # ----- 1b) Name already taken in the target folder? -----
    clashing: list[UserFile] = []
    if replace_row is not None:
        clashing, on_conflict = [replace_row], "replace"
    elif on_conflict != "allow" and route is None and owner_id is not None:
        clashing = list(
            (
                await db.execute(
                    select(UserFile).where(
                        UserFile.user_id == owner_id,
                        UserFile.folder_id == parent_folder.id
                        if parent_folder is not None
                        else UserFile.folder_id.is_(None),
                        func.lower(UserFile.filename) == clean_name.lower(),
                        UserFile.trashed_at.is_(None),
                    )
                )
            ).scalars()
        )
        if clashing and on_conflict == "ask":
            await _close()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "name_exists",
                    "existing_id": str(clashing[0].id),
                    "message": f"“{clean_name}” is already in this folder.",
                },
            )
        if clashing and on_conflict == "replace":
            roots = await _workspace_roots(db)
            if ws_target is None and await _in_workspace_tree(db, clashing[0].folder_id, roots):
                on_conflict = "keep_both"  # a workspace's file isn't Drive's to replace
        if clashing and on_conflict == "keep_both":
            clean_name = await _free_file_name(db, owner_id, parent_folder, clean_name)
            clashing = []

    # Replace keeps the file and its old bytes as a version (WP-8.1) — the
    # same file, so its shares, star, comments and links stay. (A file that
    # isn't versioned as bytes, like a Docs document, is still replaced by
    # a new one, the old going to the trash.)
    replacing: UserFile | None = None
    if clashing and on_conflict == "replace":
        from app.files.blob_versions import blob_kind

        if blob_kind(clashing[0]) is not None:
            replacing = clashing[0]

    # ----- 2) Storage cap pre-check (cheap, can save a write) -----
    # We don't know the exact final size until the body is on disk,
    # but if the user is *already* over their cap there's no point
    # streaming bytes only to roll them back. Recheck after the
    # write completes for the actual exact-size enforcement.
    quota: StorageQuota | None = None
    if owner_id is not None:
        quota = await get_quota(db, quota_user)
        if quota.cap_bytes is not None and quota.used_bytes >= quota.cap_bytes:
            await _audit_upload_rejection(
                db,
                request=request,
                user=user,
                code="storage_cap",
                declared_filename=clean_name,
            )
            await _close()
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    "The workspace owner's storage is full — free up space or "
                    "raise their quota before adding more files."
                    if ws_target
                    else "You've reached your storage limit. Delete some files or "
                    "ask an admin to raise your quota."
                ),
            )

    # ----- 2b) A resumable upload asks before sending a byte (WP-8.2) -----
    # Its type must be allowed (the bytes are sniffed when they arrive), and
    # its size is known, so the storage check can be exact now.
    if check_size is not None:
        from app.files.safety import is_extension_allowed

        if not is_extension_allowed(clean_name):
            await _audit_upload_rejection(
                db, request=request, user=user, code="bad_extension", declared_filename=clean_name,
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Files of type {ext or '(none)'!r} are not allowed",
            )
        if quota is not None and quota.cap_bytes is not None and check_size > 0:
            grows = check_size if replacing is None or quota.versions_counted else check_size - replacing.size_bytes
            if grows > 0 and quota.used_bytes + grows > quota.cap_bytes:
                await _audit_upload_rejection(
                    db, request=request, user=user, code="storage_cap", declared_filename=clean_name,
                )
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=(
                        "This upload would push the workspace owner over their storage limit."
                        if ws_target
                        else "This upload would push you over your storage limit. "
                        "Delete some files or ask an admin to raise your quota."
                    ),
                )
        return UploadPlan(clean_name=clean_name, owner_id=owner_id, quota_user=quota_user)

    # ----- 3) Stream into staging, hashing as it goes (WP-7.1) -----
    # Nothing appears at its final path until it has passed every check
    # below; on any failure the staged copy is simply removed. A finished
    # resumable upload arrives already staged (WP-8.2).
    from app.files import blobstore as _blobs

    new_id = uuid.uuid4()
    rel_path = storage_path_for(owner_id, new_id, ext)
    if staged_in is not None:
        staged = staged_in
    else:
        assert upload is not None
        try:
            staged = await _blobs.stage_upload(upload.file, size_limit=MAX_FILE_BYTES)
        except _blobs.BlobTooLarge:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File exceeds maximum size of {MAX_FILE_BYTES // (1024 * 1024)} MB",
            )
        finally:
            await _close()
    size = staged.size

    try:
        # Reject empty uploads up front. Phone browsers occasionally deliver
        # a multipart body with zero bytes of payload when the app is
        # backgrounded mid-upload; failing here gives a clearer 400 than the
        # MIME check would.
        if size <= 0 and allow_empty:
            # Nothing to sniff: the extension decides (and must be allowed).
            from app.files.safety import is_extension_allowed

            if not is_extension_allowed(clean_name):
                await _audit_upload_rejection(
                    db, request=request, user=user, code="bad_extension", declared_filename=clean_name,
                )
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That type of file isn't allowed.")
        elif size <= 0:
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

        # ----- 4) Magic-byte sniff, on the staged copy -----
        try:
            canonical_mime = (mimetypes.guess_type(clean_name)[0] or "application/octet-stream") if size <= 0 else await asyncio.to_thread(
                sniff_and_validate,
                staged.path,
                declared_filename=clean_name,
                declared_mime=declared_mime,
            )
        except UnsafeUploadError as e:
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

        # ----- 5) The original is kept byte-exact -----
        # Location is kept for the owner and people they share with, and
        # removed on the way out instead — public links, AI providers
        # (app.files.egress, decision D13).

        # ----- 6) Resolve the auto-routed destination (now that we know
        # the upload will succeed) -----
        if parent_folder is None and scope == "mine":
            if route == "chat":
                parent_folder = await folder_for_chat_upload(db, user)
                # Dedup (D1): re-attaching the SAME file (identical name +
                # size) shouldn't spawn a fresh Chat Uploads row every time.
                # Scoped to Chat Uploads only, so files the user deliberately
                # filed are never deduped.
                existing = (
                    await db.execute(
                        select(UserFile)
                        .where(
                            UserFile.user_id == owner_id,
                            UserFile.folder_id == parent_folder.id,
                            UserFile.filename == clean_name,
                            UserFile.size_bytes == size,
                            UserFile.trashed_at.is_(None),
                        )
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if existing is not None:
                    return _file_to_response(existing, caller=user)
            elif route == "camera":
                # Phone backups and shared photos (WP-8.5): Camera
                # Uploads/YYYY/MM by when it was taken — and not twice.
                same = await _already_in_camera_uploads(db, user, staged.sha256)
                if same is not None:
                    return _file_to_response(same, caller=user)
                from app.photos.library import user_zone

                when = await _taken_or_modified(staged.path, canonical_mime, last_modified, user_zone(user))
                parent_folder = await camera_month_folder(db, user, when)
            elif route == "generated":
                # Reserved for the future "AI made this for you" flow —
                # routes by MIME so images/audio/video land in Media and
                # everything else (including PDFs) lands in Files.
                parent_folder = await folder_for_generated(
                    db, user, canonical_mime
                )

        # ----- 7) Storage cap, exactly, one upload at a time per person -----
        # Two uploads finishing together each passed the pre-check against
        # the same usage and together overshot the cap (Part C §5.3). The
        # per-owner lock holds until this request's row is committed, so the
        # next one sees it.
        if owner_id is not None:
            await lock_owner_quota(db, owner_id)
            quota = await get_quota(db, quota_user)
            # Replacing: what grows is the new bytes, less the old ones unless
            # versions already count (WP-6.2).
            grows = size if replacing is None or quota.versions_counted else size - replacing.size_bytes
            if quota.cap_bytes is not None and grows > 0 and quota.used_bytes + grows > quota.cap_bytes:
                await db.rollback()
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
                        "This upload would push the workspace owner over their storage limit."
                        if ws_target
                        else "This upload would push you over your storage limit. "
                        "Delete some files or ask an admin to raise your quota."
                    ),
                )
            if ws_target is not None:
                from app.workspaces.drive_router import workspace_cap_exceeded

                if await workspace_cap_exceeded(db, ws_target.ws, size):
                    await db.rollback()
                    await _audit_upload_rejection(
                        db, request=request, user=user, code="workspace_cap", declared_filename=clean_name,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=(
                            "This upload would exceed the workspace's storage cap. "
                            "Remove some files or raise the cap in Settings."
                        ),
                    )

        # ----- 8) Into place, then the row -----
        ensure_bucket(owner_id)
        await asyncio.to_thread(_blobs.blobstore.commit, staged, rel_path)
    finally:
        _blobs.blobstore.discard(staged)

    if replacing is not None:
        from app.files.blob_versions import refresh_after_change, replace_bytes

        await replace_bytes(
            db, replacing, new_path=rel_path, size=size, source=version_source, author_id=user.id,
            staged=staged, mime=canonical_mime,
        )
        replacing.client_mtime = client_mtime_from(last_modified) or replacing.client_mtime
        try:
            await db.commit()
        except Exception:
            delete_blob(rel_path)
            raise
        await refresh_after_change(replacing)
        await db.commit()
        await db.refresh(replacing)
        if ws_target is not None:
            # Still the workspace's file; its search index catches up.
            from app.workspaces.drive_router import index_file_for_workspace

            if background is not None:
                background.add_task(index_file_for_workspace, ws_target.ws.id, replacing.id)
            else:
                from app.background import spawn

                spawn(index_file_for_workspace(ws_target.ws.id, replacing.id), name=f"ws_index_{replacing.id}")
        return _file_to_response(replacing, caller=user)

    row = UserFile(
        id=new_id,
        user_id=owner_id,
        folder_id=parent_folder.id if parent_folder else None,
        filename=clean_name,
        original_filename=clean_name,
        mime_type=canonical_mime,
        size_bytes=size,
        storage_path=rel_path,
        client_mtime=client_mtime_from(last_modified),
    )
    _blobs.record(row, staged)
    db.add(row)
    try:
        await db.commit()
    except Exception:
        # If the DB insert fails, get rid of the orphaned blob so we don't
        # accumulate garbage on disk.
        delete_blob(rel_path)
        raise
    await db.refresh(row)

    # ----- 8b) Replace a file that isn't versioned as bytes: it goes to the
    # trash (restorable from Trash). -----
    if clashing and on_conflict == "replace":
        from app.files import mass_delete

        now_ts = datetime.now(timezone.utc)
        for old in clashing:
            old.trashed_at = now_ts
            mass_delete.apply(old, user)
        await db.commit()
        await db.refresh(row)

    # ----- 9) FTS content extraction (best effort, synchronous) -----
    # We run this *after* the commit so a failure here can't roll
    # back the upload. Text-ish files and PDFs populate
    # ``content_text`` so the Drive search index sees their
    # contents; everything else stays NULL and only the filename
    # side of ``content_tsv`` catches matches.
    from app.files.extraction import extract_content_text
    from app.files.office_formats import office_ext

    is_office = office_ext(row.filename) is not None
    if is_office:
        # Word / Excel / PowerPoint parsing is heavy and untrusted: it runs
        # on the Arq worker (WP-4.3, Part C §3.7), never in the request.
        from app.tasks.queue import enqueue_office_text

        await enqueue_office_text(row.id)
    # Its faithful preview, when the optional converter runs (Stage 12).
    from app.files import convert

    if convert.enabled() and convert.convertible(row.filename):
        await convert.request(row)
    # A photo's or video's metadata — date taken, place, camera — is read on
    # the worker too (WP-7.3).
    from app.files.media_meta import media_kind

    if media_kind(row.mime_type) is not None:
        from app.tasks.queue import enqueue_media

        await enqueue_media(row.id)
    try:
        content_text = None if is_office else await asyncio.to_thread(extract_content_text, row)
        if content_text is not None:
            row.content_text = content_text
            await db.commit()
            await db.refresh(row)
    except Exception:  # noqa: BLE001 — extraction must never break upload
        # Roll back first: after a failed flush even reading ``row.id``
        # needs the session, and raised again (a 500 for a stored file).
        await db.rollback()
        logger.exception(
            "FTS extraction failed for file %s; leaving content_text NULL",
            new_id,
        )

    # Into a workspace's drive: pinned, indexed, and its own automations
    # told (WP-7.6).
    if ws_target is not None:
        from app.workspaces.drive_router import adopt_workspace_upload

        await adopt_workspace_upload(db, ws_target, row, user, background)
        await db.refresh(row)
        return _file_to_response(row, caller=user)

    # Automations (E-batch): a personal-Drive upload can fire the owner's
    # personal event-triggered flows. Best-effort, non-blocking.
    from app.tasks.events import EVENT_FILE_ADDED, emit_user_event

    emit_user_event(
        user_id=owner_id,
        event=EVENT_FILE_ADDED,
        payload={
            "file_id": str(row.id),
            "filename": row.filename,
            "mime_type": row.mime_type,
            "size_bytes": row.size_bytes,
            "uploaded_by": user.username,
            "folder_id": str(parent_folder.id) if parent_folder else None,
            "folder_name": parent_folder.name if parent_folder else None,
        },
    )

    return _file_to_response(row, caller=user)


@router.get("/{file_id:uuid}", response_model=FileResponse)
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


@router.get("/{file_id:uuid}/download")
async def download_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FastAPIFileResponse:
    from app.files.office import content_for_shell, export_for_download, get_office_access, is_shell

    shell = await db.get(UserFile, file_id)
    if shell is not None and is_shell(shell):
        # A sheet / whiteboard downloads as .xlsx / .excalidraw, exported
        # from its live content (WP-3.2) — it has no blob of its own.
        if await get_office_access(db, shell, user) == "none":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        entity = await content_for_shell(db, shell)
        if entity is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        data, name, mime = await asyncio.to_thread(export_for_download, shell, entity)
        return Response(
            content=data,
            media_type=mime,
            headers={
                "Content-Disposition": _content_disposition(name),
                "X-Content-Type-Options": "nosniff",
                "Cross-Origin-Resource-Policy": "same-origin",
            },
        )
    row = await _load_readable_file(db, file_id, user)
    path = absolute_path(row.storage_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File data missing on disk"
        )
    media_type = _safe_download_mime(row.mime_type, row.filename)
    from app.files.pdf_edit import revision as _revision

    return FastAPIFileResponse(
        path=str(path),
        media_type=media_type,
        headers={
            # RFC 6266 attachment disposition — never inline.
            "Content-Disposition": _content_disposition(row.filename),
            # Which bytes these are — the PDF viewer's save sends it back
            # so a save over someone else's newer one is refused (WP-6.5).
            "X-File-Revision": _revision(row),
            # Defence-in-depth headers so a stale or hostile blob
            # can't be sniffed into a script context even if a future
            # change accidentally drops the canonical MIME path.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


def _render_thumb_bytes(path, is_pdf: bool, size: int = 320) -> bytes:
    """Render a 320px JPEG thumbnail for an image or a PDF's first page.

    Synchronous + blocking (Pillow / PDFium), so callers offload it to a
    thread. PDFs render via ``pypdfium2`` (a pure-wheel PDFium binding —
    no system libs), which lets a folder of generated reports read like a
    real drive instead of a wall of identical PDF icons.
    """
    from io import BytesIO

    from PIL import Image, ImageOps

    buf = BytesIO()
    if is_pdf:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(path))
        try:
            # ≈144 DPI for a tile, more for the preview size.
            im = pdf[0].render(scale=2.0 if size <= 320 else 3.0).to_pil().convert("RGB")
        finally:
            pdf.close()
        im.thumbnail((size, size))
        im.save(buf, format="JPEG", quality=80)
    else:
        with Image.open(path) as im:
            # draft() BEFORE anything decodes: it lets a big JPEG decode at
            # 1/2–1/8 scale. After exif_transpose (which decodes the whole
            # image) it did nothing — a full decode per tile (R-207).
            im.draft("RGB", (size * 2, size * 2))
            im = ImageOps.exif_transpose(im)  # honour camera orientation
            im = im.convert("RGB")
            im.thumbnail((size, size))
            im.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


_THUMB_SIZES = (320, 1024)


def _thumb_cache_path(file_id: uuid.UUID, size_bytes: int, size: int):
    from app.files import storage

    return storage.UPLOAD_ROOT / "derived" / "thumbs" / f"{file_id}-{size_bytes}-{size}.jpg"


def _cached_thumb_bytes(path, is_pdf: bool, cache, size: int) -> bytes:
    """Render once, then serve from ``derived/thumbs`` — a blob is immutable
    for a given id and size, and re-rendering on every request cost a full
    decode each time (R-207)."""
    try:
        return cache.read_bytes()
    except OSError:
        pass
    data = _render_thumb_bytes(path, is_pdf, size)
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, cache)
    except OSError:
        pass  # a cache miss next time, not an error
    return data


@router.get("/{file_id:uuid}/thumbnail")
async def file_thumbnail(
    file_id: uuid.UUID,
    request: Request,
    size: int = Query(default=320),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Return a small, downscaled JPEG preview of an image or PDF file.

    Powers the Drive grid's thumbnails so a folder of photos / documents
    reads like a real drive rather than a wall of generic icons. Images
    and PDFs (first page) are thumbnailed; anything else gets a 415 and
    the client falls back to a type icon. Rendering is offloaded to a
    thread and marked privately cacheable so re-renders hit the browser
    cache rather than re-hitting the server.
    """
    row = await _load_readable_file(db, file_id, user)
    if row.source_kind == GeneratedKind.WHITEBOARD.value:
        return _whiteboard_thumbnail(row, request)
    if row.source_kind == GeneratedKind.DOCUMENT.value:
        return await _document_thumbnail(row, request)
    from app.files import convert

    if convert.enabled() and convert.convertible(row.filename):
        return await _office_thumbnail(row, request)
    # A photo's or video's renditions from the media worker (WP-7.4): a WebP
    # tile, or the 1440 px preview (a video's poster) for the viewer.
    derived = await _derived_thumbnail(db, row, size, request)
    if derived is not None:
        return derived
    mime = (row.mime_type or "").lower()
    name = (row.filename or "").lower()
    is_image = mime.startswith("image/")
    is_pdf = mime == "application/pdf" or name.endswith(".pdf")
    if not (is_image or is_pdf):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="No thumbnail for this file type",
        )
    path = absolute_path(row.storage_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File data missing on disk"
        )
    # 320 for tiles, 1024 for the preview / lightbox.
    size = 1024 if size > 320 else 320
    # Strong validator so the browser can revalidate cheaply: blob is
    # immutable, so id + size is enough to key the cache.
    etag = f'"thumb-{row.id}-{row.size_bytes}-{size}"'
    cache_headers = {
        "Cache-Control": "private, max-age=86400",
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if etag in (request.headers.get("if-none-match") or ""):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=cache_headers)

    try:
        content = await run_in_threadpool(
            _cached_thumb_bytes, path, is_pdf, _thumb_cache_path(row.id, row.size_bytes, size), size
        )
    except Exception:
        # Corrupt / unsupported payloads shouldn't 500 the grid — let the
        # client fall back to a type icon.
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Could not render thumbnail",
        )

    return Response(content=content, media_type="image/jpeg", headers=cache_headers)


async def _derived_thumbnail(db: AsyncSession, row: UserFile, size: int, request: Request) -> Response | None:
    from app.files.derivatives import rendition_path
    from app.files.models import FileMedia

    media = await db.get(FileMedia, row.id)
    if media is None or media.derivative_state != "ready" or not media.renditions:
        return None
    names = ["thumb.webp"] if size <= 320 else ["preview.webp", "poster.webp", "thumb.webp"]
    for name in names:
        info = media.renditions.get(name)
        if not info:
            continue
        path = rendition_path(row.id, name)
        nbytes = info.get("bytes", 0)
        etag = f'"d-{row.id}-{name}-{nbytes}"'
        headers = {
            "Cache-Control": "private, max-age=604800",
            "ETag": etag,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        }
        if etag in (request.headers.get("if-none-match") or ""):
            return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
        try:
            data = await asyncio.to_thread(path.read_bytes)
        except OSError:
            return None  # renditions gone (cleared) — the old path renders
        return Response(content=data, media_type="image/webp", headers=headers)
    return None


def _jpeg(data: bytes, etag: str, request: Request) -> Response:
    headers = {
        "Cache-Control": "private, max-age=60",
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if etag in (request.headers.get("if-none-match") or ""):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=data, media_type="image/jpeg", headers=headers)


async def _document_thumbnail(row: UserFile, request: Request) -> Response:
    """A Doc's first page (made on the worker); 415 while it's being made,
    so the grid shows the icon and asks again when the Doc changes."""
    from app.files import doc_thumbs

    if not await asyncio.to_thread(doc_thumbs.fresh, row):
        await doc_thumbs.request(row)
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="No thumbnail yet")
    try:
        data = await asyncio.to_thread(doc_thumbs.doc_thumb_path(row.id).read_bytes)
    except OSError:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="No thumbnail yet") from None
    import zlib

    return _jpeg(data, f'"doc-{row.id}-{zlib.crc32(doc_thumbs.version_key(row).encode())}"', request)


async def _office_thumbnail(row: UserFile, request: Request) -> Response:
    """Page one of the converter's PDF of an Office file (asking for one
    if there isn't one yet)."""
    from app.files import convert, doc_thumbs

    try:
        data = await asyncio.to_thread(doc_thumbs.office_thumb, row)
    except Exception:  # noqa: BLE001 — a damaged PDF: the icon
        data = None
    if data is None:
        await convert.request(row)
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="No thumbnail yet")
    return _jpeg(data, f'"office-{row.id}-{row.size_bytes}"', request)


def _whiteboard_thumbnail(row: UserFile, request: Request) -> Response:
    """The PNG a whiteboard's editor last pushed (WP-3.4); 415 until then,
    so the grid shows the type icon."""
    from app.files.office_router import whiteboard_thumb_path

    path = whiteboard_thumb_path(row.id)
    try:
        data = path.read_bytes()
        mtime = int(path.stat().st_mtime)
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="No thumbnail yet"
        )
    etag = f'"wb-{row.id}-{mtime}"'
    headers = {
        "Cache-Control": "private, max-age=60",
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if etag in (request.headers.get("if-none-match") or ""):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=data, media_type="image/png", headers=headers)


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


@router.get("/{file_id:uuid}/source", response_model=SourceContentResponse)
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


@router.put("/{file_id:uuid}/source", response_model=SourceContentResponse)
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
        rendered.content_text = await asyncio.to_thread(extract_content_text, rendered)
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


@router.patch("/{file_id:uuid}", response_model=FileResponse)
async def update_file(
    file_id: uuid.UUID,
    payload: FileUpdateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_writable_file(db, file_id, user)
    if payload.filename is not None or payload.folder_id is not None or payload.move_to_root:
        await _guard_workspace_file(db, row)

    if payload.filename is not None:
        row.filename = payload.filename.strip()
        from app.files.office import content_for_shell, is_shell, shell_filename

        if is_shell(row):
            # Keep the office suffix; the editor's title is the name.
            from app.files.office_templates import office_title

            title = office_title(row).strip() or "Untitled"
            row.filename = row.original_filename = shell_filename(row.source_kind, title)
            entity = await content_for_shell(db, row)
            if entity is not None:
                entity.title = title[:200]

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


@router.delete("/{file_id:uuid}", status_code=status.HTTP_204_NO_CONTENT)
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
        await _purge_file_rows(db, [row])
        await db.commit()
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Default path: soft-trash. Idempotent — re-trashing a trashed
    # row just refreshes the timestamp.
    await _guard_workspace_file(db, row)
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


@router.post("/{file_id:uuid}/trash", response_model=FileResponse)
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
    from app.files import mass_delete

    row = await _load_writable_file(db, file_id, user)
    await _guard_workspace_file(db, row)
    row.trashed_at = datetime.now(timezone.utc)
    mass_delete.apply(row, user)
    await db.commit()
    await mass_delete.check(db, user)
    await db.refresh(row)
    return _file_to_response(row, caller=user)


async def _live_ancestor(db: AsyncSession, folder_id: uuid.UUID | None) -> FileFolder | None:
    """The nearest folder at or above ``folder_id`` that isn't in the trash
    (None = the root)."""
    cur = folder_id
    for _ in range(64):
        if cur is None:
            return None
        f = await db.get(FileFolder, cur)
        if f is None:
            return None
        if f.trashed_at is None:
            return f
        cur = f.parent_id
    return None


async def _folder_path(db: AsyncSession, folder: FileFolder | None) -> str:
    """"My files / A / B" for a folder (or the root)."""
    names: list[str] = []
    cur = folder
    for _ in range(64):
        if cur is None:
            break
        names.append(cur.name)
        cur = await db.get(FileFolder, cur.parent_id) if cur.parent_id else None
    return " / ".join(["My files", *reversed(names)])


async def _free_folder_name(
    db: AsyncSession, folder: FileFolder, parent_id: uuid.UUID | None
) -> str:
    """``folder.name``, or "name (1)", "(2)"… if a live sibling has it — the
    unique index covers live folders only now (R-209)."""
    siblings = set(
        (
            await db.execute(
                select(FileFolder.name).where(
                    FileFolder.user_id == folder.user_id
                    if folder.user_id is not None
                    else FileFolder.user_id.is_(None),
                    FileFolder.parent_id == parent_id
                    if parent_id is not None
                    else FileFolder.parent_id.is_(None),
                    FileFolder.trashed_at.is_(None),
                    FileFolder.id != folder.id,
                )
            )
        ).scalars()
    )
    if folder.name not in siblings:
        return folder.name
    n = 1
    while f"{folder.name} ({n})" in siblings:
        n += 1
    return f"{folder.name} ({n})"


async def _restore_one_file(db: AsyncSession, row: UserFile) -> str:
    """Un-trash a file into its folder, or the nearest live folder above it
    when that's still in the trash — a restored file used to land inside an
    invisible trashed folder (R-209). Returns where it went."""
    dest = await _live_ancestor(db, row.folder_id)
    row.folder_id = dest.id if dest is not None else None
    row.trashed_at = None
    return await _folder_path(db, dest)


async def _restore_folder_tree(db: AsyncSession, folder: FileFolder) -> str:
    """Un-trash a folder and what was trashed with it (a 5-second window, so
    things trashed on their own earlier stay put), into the nearest live
    parent, renaming on a name clash. Returns where it went."""
    from sqlalchemy import update

    # Home and name first: un-trashing next to a live namesake would hit
    # the (live-only) unique index.
    dest = await _live_ancestor(db, folder.parent_id)
    folder.parent_id = dest.id if dest is not None else None
    folder.name = await _free_folder_name(db, folder, folder.parent_id)
    await db.flush()
    if folder.trashed_at is not None:
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
        await db.refresh(folder)
    return await _folder_path(db, dest)


@router.post("/{file_id:uuid}/restore", response_model=FileResponse)
async def restore_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    row = await _load_writable_file(db, file_id, user)
    location = await _restore_one_file(db, row)
    await db.commit()
    await db.refresh(row)
    resp = _file_to_response(row, caller=user)
    resp.location = location
    return resp


@router.post("/folders/{folder_id:uuid}/trash", response_model=FolderResponse)
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
    await _guard_workspace_folder(db, folder)

    from app.files import mass_delete

    now = datetime.now(timezone.utc)
    folder_ids = await _descendant_folder_ids(db, folder.id)
    who = mass_delete.stamp(user)

    await db.execute(
        update(FileFolder)
        .where(FileFolder.id.in_(folder_ids))
        .values(trashed_at=now, **who)
    )
    await db.execute(
        update(UserFile)
        .where(UserFile.folder_id.in_(folder_ids))
        .values(trashed_at=now, **who)
    )
    await db.commit()
    await mass_delete.check(db, user)
    await db.refresh(folder)
    return _folder_to_response(folder, caller=user)


@router.post("/folders/{folder_id:uuid}/restore", response_model=FolderResponse)
async def restore_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FolderResponse:
    """Restore a folder subtree from the trash.

    We only un-trash descendants whose ``trashed_at`` matches the
    folder's ``trashed_at`` within a 5-second window — this keeps
    files the user *individually* trashed earlier from getting
    accidentally rescued when the parent folder is restored. The folder
    goes back into the nearest live parent (R-209).
    """
    folder = await _load_writable_folder(db, folder_id, user)
    _assert_not_system_folder(folder, "restore")

    if folder.trashed_at is None:
        # Already live — idempotent.
        return _folder_to_response(folder, caller=user)

    location = await _restore_folder_tree(db, folder)
    await db.commit()
    await db.refresh(folder)
    resp = _folder_to_response(folder, caller=user)
    resp.location = location
    return resp


# --------------------------------------------------------------------
# Bulk operations — one atomic call per multi-select action so the
# client doesn't have to fan out N requests. Each authorises per item
# and silently skips anything the caller can't touch (a stale id can't
# fail the whole batch). Returns how many of each kind were affected.
# --------------------------------------------------------------------
class _BulkIds(BaseModel):
    file_ids: list[uuid.UUID] = Field(default_factory=list)
    folder_ids: list[uuid.UUID] = Field(default_factory=list)


class _BulkMove(_BulkIds):
    target_folder_id: uuid.UUID | None = None
    move_to_root: bool = False


class _BulkResult(BaseModel):
    files: int
    folders: int
    # Left alone because a workspace owns them (R-215).
    skipped: int = 0


async def _bulk_load_file(db, fid, user):
    try:
        return await _load_writable_file(db, fid, user)
    except HTTPException:
        return None


async def _bulk_load_folder(db, did, user):
    try:
        return await _load_writable_folder(db, did, user)
    except HTTPException:
        return None


@router.post("/bulk/trash", response_model=_BulkResult)
async def bulk_trash(
    payload: _BulkIds,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> _BulkResult:
    from sqlalchemy import update

    from app.files import mass_delete

    now = datetime.now(timezone.utc)
    who = mass_delete.stamp(user)
    nf = nd = skipped = 0
    roots = await _workspace_roots(db)
    for fid in payload.file_ids:
        row = await _bulk_load_file(db, fid, user)
        if row is None:
            continue
        if await _in_workspace_tree(db, row.folder_id, roots):
            skipped += 1  # the workspace's, not Drive's, to delete (R-215)
            continue
        row.trashed_at = now
        mass_delete.apply(row, user)
        nf += 1
    for did in payload.folder_ids:
        folder = await _bulk_load_folder(db, did, user)
        if folder is None or folder.system_kind is not None:
            continue
        owner = await _owning_workspace(db, folder.id, roots)
        if owner is not None and owner[2] <= 1:
            skipped += 1
            continue
        ids = await _descendant_folder_ids(db, folder.id)
        await db.execute(
            update(FileFolder).where(FileFolder.id.in_(ids)).values(trashed_at=now, **who)
        )
        await db.execute(
            update(UserFile)
            .where(UserFile.folder_id.in_(ids))
            .values(trashed_at=now, **who)
        )
        nd += 1
    await db.commit()
    await mass_delete.check(db, user)
    return _BulkResult(files=nf, folders=nd, skipped=skipped)


class _RestoreDevice(BaseModel):
    credential: str = Field(min_length=1, max_length=64)


@router.get("/trash/restore-device")
async def restore_device_summary(
    credential: str = Query(min_length=1, max_length=64),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """What "restore everything this device deleted" would put back (WP-7.2)
    — the caller's own files and folders trashed from ``credential`` in the
    last 48 hours."""
    from app.auth.credential import current_credential
    from app.files import mass_delete

    out = await mass_delete.summary(db, user, credential)
    return {**out, "this_device": credential == (current_credential() or f"user:{user.id}")}


@router.post("/trash/restore-device")
async def restore_device(
    payload: _RestoreDevice,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    """Restore everything of the caller's that one device sent to the trash
    in the last 48 hours — the mass-delete alert's button (WP-7.2)."""
    from app.files import mass_delete

    return await mass_delete.restore_credential(db, user, payload.credential)


@router.post("/bulk/restore", response_model=_BulkResult)
async def bulk_restore(
    payload: _BulkIds,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> _BulkResult:
    """Same rules as the single restores: the 5-second window for a
    folder's contents and the nearest live parent — it used to un-trash a
    whole subtree, including things trashed on their own (R-209)."""
    nf = nd = 0
    for did in payload.folder_ids:
        folder = await _bulk_load_folder(db, did, user)
        if folder is None or folder.system_kind is not None or folder.trashed_at is None:
            continue
        await _restore_folder_tree(db, folder)
        nd += 1
    for fid in payload.file_ids:
        row = await _bulk_load_file(db, fid, user)
        if row is None or row.trashed_at is None:
            continue
        await _restore_one_file(db, row)
        nf += 1
    await db.commit()
    return _BulkResult(files=nf, folders=nd)


@router.post("/bulk/purge", response_model=_BulkResult)
async def bulk_purge(
    payload: _BulkIds,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> _BulkResult:
    """Trash's "Delete forever" for a selection of the caller's own items.

    Only items already in the trash can be purged — a stale or hostile id
    for a live file is skipped, never destroyed. Returns real counts so the
    UI says what actually happened (it used to report success for a no-op).
    """
    nf = nd = 0
    rows = []
    for fid in payload.file_ids:
        row = await _bulk_load_file(db, fid, user)
        if row is None or row.trashed_at is None:
            continue
        rows.append(row)
    await _purge_file_rows(db, rows)
    nf += len(rows)
    for did in payload.folder_ids:
        folder = await _bulk_load_folder(db, did, user)
        if folder is None or folder.trashed_at is None or folder.system_kind is not None:
            continue
        nf += await _purge_folder_subtree(db, folder)
        nd += 1
    await db.commit()
    return _BulkResult(files=nf, folders=nd)


@router.post("/bulk/move", response_model=_BulkResult)
async def bulk_move(
    payload: _BulkMove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> _BulkResult:
    target: FileFolder | None = None
    if not payload.move_to_root and payload.target_folder_id is not None:
        target = await _load_writable_folder(db, payload.target_folder_id, user)

    nf = nd = skipped = 0
    roots = await _workspace_roots(db)
    for fid in payload.file_ids:
        row = await _bulk_load_file(db, fid, user)
        if row is None:
            continue
        if await _in_workspace_tree(db, row.folder_id, roots):
            skipped += 1
            continue
        row.folder_id = target.id if target else None
        nf += 1
    for did in payload.folder_ids:
        folder = await _bulk_load_folder(db, did, user)
        if folder is None or folder.system_kind is not None:
            continue
        owner = await _owning_workspace(db, folder.id, roots)
        if owner is not None and owner[2] <= 1:
            skipped += 1
            continue
        if target is not None and (
            folder.id == target.id
            or await _would_create_cycle(db, moving=folder, new_parent=target)
        ):
            continue  # skip an illegal move rather than fail the batch
        folder.parent_id = target.id if target else None
        nd += 1
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A name collision occurred while moving items.",
        )
    return _BulkResult(files=nf, folders=nd, skipped=skipped)


@router.post("/bulk/star", response_model=_BulkResult)
async def bulk_star(
    payload: _BulkIds,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> _BulkResult:
    return await _bulk_set_star(db, user, payload, star=True)


@router.post("/bulk/unstar", response_model=_BulkResult)
async def bulk_unstar(
    payload: _BulkIds,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> _BulkResult:
    return await _bulk_set_star(db, user, payload, star=False)


async def _bulk_set_star(db, user, payload: _BulkIds, star: bool) -> _BulkResult:
    when = datetime.now(timezone.utc) if star else None
    nf = nd = 0
    for fid in payload.file_ids:
        row = await _bulk_load_file(db, fid, user)
        if row is None:
            continue
        row.starred_at = when
        nf += 1
    for did in payload.folder_ids:
        folder = await _bulk_load_folder(db, did, user)
        if folder is None:
            continue
        folder.starred_at = when
        nd += 1
    await db.commit()
    return _BulkResult(files=nf, folders=nd)


@router.post("/bulk/zip", status_code=status.HTTP_202_ACCEPTED)
async def bulk_zip(
    payload: _BulkIds,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Start a zip of the selected files and folders (WP-7.6): every file
    you can read, folders with their whole structure. It's written in the
    background; poll ``GET /zips/{job_id}`` for a download link."""
    from app.files import disk_guard, zip_jobs

    try:
        planned = await zip_jobs.plan(db, user, list(payload.file_ids), list(payload.folder_ids))
    except zip_jobs.ZipTooLarge as e:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(e)) from None
    if not planned["entries"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing to download.")
    try:
        disk_guard.ensure_room(planned["bytes"])
    except disk_guard.DiskFull:
        raise HTTPException(
            status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
            detail="There isn't room on the server to make this zip. Download fewer items at a time.",
        ) from None
    folder_names: list[str] = []
    for did in payload.folder_ids:
        folder = await db.get(FileFolder, did)
        if folder is not None:
            folder_names.append(folder.name)
    name = zip_jobs.archive_name(folder_names, len(payload.file_ids))
    job_id = await zip_jobs.create(user.id, planned, name)
    await zip_jobs.start(job_id)
    files = sum(1 for e in planned["entries"] if e[1] != "dir")
    return {"job_id": job_id, "files": files, "bytes": planned["bytes"], "name": name}


@router.get("/zips/{job_id}")
async def zip_status(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Where a zip is up to; ``url`` (a signed link) once it's ready."""
    from app.files import media_urls, zip_jobs

    job = await zip_jobs.load(str(job_id))
    if job is None or job.get("user_id") != str(user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This zip has expired.")
    url = None
    if job["state"] == "ready":
        url = media_urls.sign(job_id, user.id, user.token_version, "zip", media_urls.version_tag(job.get("bytes")))
    return {
        "state": job["state"], "files": job["files"], "done": job["done"], "bytes": job["bytes"],
        "source_bytes": job["source_bytes"], "name": job["name"], "error": job["error"], "url": url,
    }


@router.get("/trash", response_model=TrashListResponse)
async def list_trash(
    scope: Scope = Query("mine"),
    limit: int | None = Query(default=None, ge=1, le=1000),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TrashListResponse:
    """List what was trashed in ``scope`` — the top-level items only, each
    with where it was (R-209).

    Trashing a 2,000-photo folder used to put 2,000+ rows here: every
    descendant was listed. Now a folder stands for its contents; restoring
    or deleting it acts on them. Newest first. Admins see the shared-pool
    trash when they pass ``scope=shared``.
    """
    from sqlalchemy.orm import aliased

    from app.files import paging

    after = paging.decode(cursor, "trashed", "desc")
    parent = aliased(FileFolder)
    folder_rows = [] if after is not None else (
        (
            await db.execute(
                select(FileFolder)
                .outerjoin(parent, parent.id == FileFolder.parent_id)
                .where(
                    _owner_filter(user),
                    FileFolder.trashed_at.is_not(None),
                    or_(FileFolder.parent_id.is_(None), parent.trashed_at.is_(None)),
                )
                .order_by(FileFolder.trashed_at.desc())
            )
        )
        .scalars()
        .all()
    )
    holder = aliased(FileFolder)
    stmt = (
        select(UserFile)
        .outerjoin(holder, holder.id == UserFile.folder_id)
        .where(
            _file_owner_filter(user),
            UserFile.trashed_at.is_not(None),
            _drive_listing_filter(),
            or_(UserFile.folder_id.is_(None), holder.trashed_at.is_(None)),
        )
    )
    rows = (await db.execute(paging.apply(stmt, UserFile.trashed_at, UserFile.id, "desc", after, limit))).scalars().all()
    # The cursor follows the rows read, before the workspace filter below.
    file_rows, next_cursor = paging.split(rows, limit, "trashed", "desc", lambda f: f.trashed_at)

    # A workspace's own items are restored from the workspace's trash;
    # restoring one here left the item itself deleted (R-215).
    roots = await _workspace_roots(db)
    folder_rows = [
        f for f in folder_rows if (await _owning_workspace(db, f.id, roots)) is None
    ]
    file_rows = [
        f for f in file_rows if not await _in_workspace_tree(db, f.folder_id, roots)
    ]

    paths: dict[uuid.UUID | None, str] = {}

    async def where(fid: uuid.UUID | None) -> str:
        if fid not in paths:
            paths[fid] = await _folder_path(db, await db.get(FileFolder, fid) if fid else None)
        return paths[fid]

    folders = []
    for f in folder_rows:
        r = _folder_to_response(f, caller=user)
        r.location = await where(f.parent_id)
        folders.append(r)
    files = []
    for f in file_rows:
        r = _file_to_response(f, caller=user)
        r.location = await where(f.folder_id)
        files.append(r)
    return TrashListResponse(folders=folders, files=files, next_cursor=next_cursor)


@router.delete("/trash", status_code=status.HTTP_204_NO_CONTENT)
async def empty_trash(
    scope: Scope = Query("mine"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete every trashed row in ``scope``.

    The blobs are tombstoned in the same transaction, not unlinked: the
    bytes stay on disk for 14 days (see :mod:`app.files.tombstones`), so
    an emptied trash can still be recovered from the nightly dump.
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

    # Workspace items in the trash are the workspace's: its own trash
    # restores or purges them. Emptying Drive's trash used to destroy them
    # for good (R-215).
    roots = await _workspace_roots(db)
    file_rows = [f for f in file_rows if not await _in_workspace_tree(db, f.folder_id, roots)]
    folder_rows = [f for f in folder_rows if (await _owning_workspace(db, f.id, roots)) is None]

    await _purge_file_rows(db, file_rows)
    for folder in folder_rows:
        # System folders can't be trashed in the first place, but
        # double-check before the nuke so a misfired admin flag
        # can't accidentally delete the Chat Uploads folder.
        if folder.system_kind is not None:
            continue
        await db.delete(folder)

    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Drive stage 1 — Starred / Recent
# --------------------------------------------------------------------
@router.post("/{file_id:uuid}/star", response_model=FileResponse)
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


@router.delete("/{file_id:uuid}/star", response_model=FileResponse)
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


@router.post("/folders/{folder_id:uuid}/star", response_model=FolderResponse)
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


@router.delete("/folders/{folder_id:uuid}/star", response_model=FolderResponse)
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
    limit: int | None = Query(default=None, ge=1, le=1000),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StarredListResponse:
    from app.files import paging

    after = paging.decode(cursor, "starred", "desc")
    folder_filter = and_(
        _owner_filter(user),
        FileFolder.starred_at.is_not(None),
        FileFolder.trashed_at.is_(None),
    )
    folder_rows = [] if after is not None else (
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
    rows = (
        await db.execute(paging.apply(select(UserFile).where(file_filter), UserFile.starred_at, UserFile.id, "desc", after, limit))
    ).scalars().all()
    file_rows, next_cursor = paging.split(rows, limit, "starred", "desc", lambda f: f.starred_at)
    resp = StarredListResponse(
        folders=[_folder_to_response(f, caller=user) for f in folder_rows],
        files=[_file_to_response(f, caller=user) for f in file_rows],
        next_cursor=next_cursor,
    )
    await fill_thumbhashes(db, resp.files, user)
    return resp


@router.get("/recent", response_model=RecentFilesResponse)
async def list_recent(
    scope: Scope = Query("mine"),
    limit: int = Query(50, ge=1, le=200),
    exclude_system_folders: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RecentFilesResponse:
    """Files the caller recently worked on, newest first.

    Two sources (WP-3.4): their own files by ``modified_at`` (content
    changes — not stars or moves, R-209), and every file they opened or
    edited (``file_activity``) — so a document shared with them, or a
    sheet in someone else's workspace, shows up too. A file is listed
    once, at its latest time. Files they can no longer open drop out.

    ``exclude_system_folders`` drops files living in the Chat
    Uploads / Generated / Workspaces system buckets — used by the
    ``@``-mention picker so it only offers files the user filed.
    """
    from sqlalchemy import case

    from app.files.models import FileActivity

    act = (
        select(FileActivity.file_id, func.max(FileActivity.at).label("at"))
        .where(FileActivity.user_id == user.id)
        .group_by(FileActivity.file_id)
        .subquery()
    )
    mine = _file_owner_filter(user)
    # GREATEST skips NULLs: an unopened own file sorts by its edit time,
    # someone else's by when the caller last opened or edited it.
    seen = func.greatest(act.c.at, case((mine, UserFile.modified_at), else_=None))
    conds = [
        or_(mine, act.c.at.is_not(None)),
        UserFile.trashed_at.is_(None),
        _drive_listing_filter(),
    ]
    if exclude_system_folders:
        conds.append(_non_system_folder_filter(user))
    rows = (
        (
            await db.execute(
                select(UserFile)
                .outerjoin(act, act.c.file_id == UserFile.id)
                .where(and_(*conds))
                .order_by(nullslast(seen.desc()))
                .limit(limit + 20)
            )
        )
        .scalars()
        .all()
    )
    out: list[UserFile] = []
    for f in rows:
        if len(out) >= limit:
            break
        if f.user_id != user.id and not await _can_still_open(db, f, user):
            continue
        out.append(f)
    resp = RecentFilesResponse(files=[_file_to_response(f, caller=user) for f in out])
    await fill_thumbhashes(db, resp.files, user)
    return resp


async def _can_still_open(db: AsyncSession, row: UserFile, user: User) -> bool:
    """Someone else's file in Recent: only while the caller can open it."""
    from app.files.office import OFFICE_SOURCE_KINDS, get_office_access

    if row.source_kind in OFFICE_SOURCE_KINDS:
        return await get_office_access(db, row, user) != "none"
    try:
        await _load_readable_file(db, row.id, user)
    except HTTPException:
        return False
    return True


# --------------------------------------------------------------------
# Drive stage 1 — Search (FTS)
# --------------------------------------------------------------------
# Search type filters → MIME prefixes / exact types / source kinds.
_SEARCH_TYPES: dict[str, tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]] = {
    "document": ((), (), ("document",)),
    "sheet": ((), (), ("sheet",)),
    "whiteboard": ((), (), ("whiteboard",)),
    "pdf": ((), ("application/pdf",), ()),
    "image": (("image/",), (), ()),
    "video": (("video/",), (), ()),
    "audio": (("audio/",), (), ()),
    "text": (("text/",), ("application/json",), ()),
}
# Uploaded Word / Excel / PowerPoint (and the OpenDocument kinds).
_OFFICE_NAME_RE = r"\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$"

_NAME_SEP = re.compile(r"[\s._\-]+")


class _Trails:
    """Folder trails for search results, cached per request: "My files / A
    / B" for yours; "Shared by sam / Projects / Q3" for what's shared with
    you — from the highest folder you were given, never above it."""

    def __init__(self, db: AsyncSession, user: User, granted: set[uuid.UUID]):
        self.db, self.user, self.granted = db, user, granted
        self._cache: dict[uuid.UUID | None, tuple[str, str | None]] = {}
        self._names: dict[uuid.UUID, str] = {}

    async def _owner_name(self, user_id: uuid.UUID | None) -> str:
        if user_id is None:
            return "someone"
        if user_id not in self._names:
            u = await self.db.get(User, user_id)
            self._names[user_id] = u.username if u is not None else "someone"
        return self._names[user_id]

    async def of_folder(self, folder: FileFolder | None, owner_id: uuid.UUID | None = None) -> tuple[str, str | None]:
        """(trail, link) for ``folder`` (``None`` = a root)."""
        key = folder.id if folder is not None else None
        if folder is None and owner_id not in (None, self.user.id):
            return f"Shared by {await self._owner_name(owner_id)}", None
        if key in self._cache:
            return self._cache[key]
        if folder is None:
            out: tuple[str, str | None] = ("My files", "/files")
        elif folder.user_id == self.user.id:
            out = (await _folder_path(self.db, folder), f"/files/folder/{folder.id}")
        else:
            names: list[str] = []
            cur: FileFolder | None = folder
            for _ in range(64):
                if cur is None or cur.id not in self.granted:
                    break
                names.append(cur.name)
                cur = await self.db.get(FileFolder, cur.parent_id) if cur.parent_id else None
            head = f"Shared by {await self._owner_name(folder.user_id)}"
            if names:
                out = (" / ".join([head, *reversed(names)]), f"/files/folder/{folder.id}?scope=shared")
            else:
                out = (head, None)
        self._cache[key] = out
        return out


@router.get("/search", response_model=FileSearchResponse)
async def search_files(
    q: str = Query(..., min_length=1, max_length=256),
    scope: Scope = Query("mine"),
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0, le=10_000),
    type: str | None = Query(default=None, max_length=16),
    modified_after: datetime | None = Query(default=None),
    owner: str = Query("any", pattern="^(any|me|others)$"),
    exclude_system_folders: bool = Query(False),
    folder_id: uuid.UUID | None = Query(default=None),
    semantic: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileSearchResponse:
    """Search the caller's files — and files and folders shared with them.

    One box for everything (WP-5.4):

    * Names match the way people type them (R-213): every word, ignoring
      ``.``, ``_`` and ``-`` ("report" finds "Q3_report.pdf"), as a prefix
      and with a little typo tolerance (trigram similarity).
    * Content matches whole words (stemmed English, or exactly, in any
      language) and, for plain queries, word prefixes as you type ("budg"
      finds "budget"); quotes, ``-exclude`` and ``OR`` work
      (:mod:`app.files.search_query`).
    * Name hits rank above content-only hits. Folders come back too —
      yours and ones shared with you — each with its full trail.
    * ``folder_id`` searches inside one folder (and its subfolders).
    * ``semantic=true`` (results page): when AI search of your files is
      on, the first page also lists ``related`` files — about the query
      without containing its words.

    Paginated with ``offset``; ``has_more`` says whether there's another
    page. Trashed rows are excluded so the search feels like "find a live
    file" instead of "find anything ever".
    """
    from sqlalchemy import case, desc, literal_column

    from app.files.search_query import drive_tsquery

    words = [w for w in _NAME_SEP.split(q.lower()) if w][:8]
    content_tsv = literal_column("content_tsv")
    tsquery = drive_tsquery(q)
    norm_name = func.regexp_replace(func.lower(UserFile.filename), r"[._\-]+", " ", "g")
    name_all = and_(*[norm_name.contains(w, autoescape=True) for w in words]) if words else None
    name_fuzzy = func.word_similarity(q.lower(), func.lower(UserFile.filename)) >= 0.5
    name_match = or_(name_all, name_fuzzy) if name_all is not None else name_fuzzy
    match = or_(name_match, content_tsv.op("@@")(tsquery))
    rank_expr = (
        case((name_all, 2.0), else_=0.0) if name_all is not None else literal_column("0.0")
    ) + func.word_similarity(q.lower(), func.lower(UserFile.filename)) + func.ts_rank(content_tsv, tsquery)
    headline_expr = func.ts_headline(
        "english",
        func.coalesce(UserFile.content_text, UserFile.filename),
        tsquery,
        "StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8, "
        "MaxFragments=1",
    )

    # Mine, plus what's shared with me: direct file grants and files inside
    # granted folders (cascade).
    granted_files = await file_ids_caller_is_granted(db, user)
    granted_folders = await expand_folder_subtree(db, await folder_ids_caller_is_granted(db, user))
    mine = _file_owner_filter(user)
    shared = or_(
        UserFile.id.in_(granted_files) if granted_files else literal_column("false"),
        UserFile.folder_id.in_(granted_folders) if granted_folders else literal_column("false"),
    )
    access = {"me": mine, "others": shared}.get(owner, or_(mine, shared))

    # Inside one folder: the caller must be able to see it.
    within: list[uuid.UUID] | None = None
    root: FileFolder | None = None
    if folder_id is not None:
        root = await db.get(FileFolder, folder_id)
        if root is None or root.trashed_at is not None or (
            root.user_id != user.id and root.id not in set(granted_folders)
        ):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
        within = await expand_folder_subtree(db, [root.id])

    files_wanted = type != "folder"
    rows: list = []
    has_more = False
    if files_wanted:
        conds = [
            access,
            UserFile.trashed_at.is_(None),
            _drive_listing_filter(),
            match,
        ]
        if exclude_system_folders:
            conds.append(_non_system_folder_filter(user))
        if modified_after is not None:
            conds.append(UserFile.modified_at >= modified_after)
        if within is not None:
            conds.append(UserFile.folder_id.in_(within))
        if type == "office":
            conds.append(and_(UserFile.source_kind.is_(None), UserFile.filename.op("~*")(_OFFICE_NAME_RE)))
        elif type in _SEARCH_TYPES:
            prefixes, exact, kinds = _SEARCH_TYPES[type]
            conds.append(
                or_(
                    *[UserFile.mime_type.startswith(p) for p in prefixes],
                    *([UserFile.mime_type.in_(exact)] if exact else []),
                    *([UserFile.source_kind.in_(kinds)] if kinds else []),
                )
            )
        by_name = case((name_match, True), else_=False)
        stmt = (
            select(UserFile, rank_expr.label("rank"), headline_expr.label("snippet"), by_name.label("by_name"))
            .where(*conds)
            .order_by(desc(rank_expr), UserFile.modified_at.desc())
            .offset(offset)
            .limit(limit + 1)
        )
        rows = (await db.execute(stmt)).all()
        has_more = len(rows) > limit
        rows = rows[:limit]

    trails = _Trails(db, user, set(granted_folders))

    # Folders by name, on the first page and only when no type filter
    # narrows to files — yours, and (unless "owned by me") shared ones.
    folder_hits: list[FolderResponse] = []
    folder_trails: dict[str, str] = {}
    if offset == 0 and type in (None, "", "folder") and modified_after is None:
        norm_folder = func.regexp_replace(func.lower(FileFolder.name), r"[._\-]+", " ", "g")
        fconds = [norm_folder.contains(w, autoescape=True) for w in words]
        own_folders = _owner_filter(user)
        shared_folders = FileFolder.id.in_(granted_folders) if granted_folders else literal_column("false")
        folder_access = {"me": own_folders, "others": shared_folders}.get(owner, or_(own_folders, shared_folders))
        where = [
            folder_access,
            FileFolder.trashed_at.is_(None),
            or_(
                and_(*fconds) if fconds else literal_column("false"),
                func.word_similarity(q.lower(), func.lower(FileFolder.name)) >= 0.5,
            ),
        ]
        if within is not None:
            where.append(FileFolder.id.in_(within))
            where.append(FileFolder.id != folder_id)
        folder_rows = (
            (
                await db.execute(
                    select(FileFolder)
                    .where(*where)
                    .order_by(desc(func.word_similarity(q.lower(), func.lower(FileFolder.name))))
                    .limit(8 if type != "folder" else 30)
                )
            )
            .scalars()
            .all()
        )
        for f in folder_rows:
            folder_hits.append(_folder_to_response(f, caller=user))
            parent = await db.get(FileFolder, f.parent_id) if f.parent_id else None
            if parent is not None and parent.user_id != user.id and parent.id not in trails.granted:
                parent = None  # shared at this folder — don't show the owner's tree above it
            trail, _link = await trails.of_folder(parent, owner_id=f.user_id)
            folder_trails[str(f.id)] = trail

    hits: list[FileSearchHit] = []
    for f, rank, snippet, named in rows:
        parent = await db.get(FileFolder, f.folder_id) if f.folder_id else None
        trail, link = await trails.of_folder(parent, owner_id=f.user_id)
        hits.append(
            FileSearchHit(
                file=_file_to_response(f, caller=user),
                rank=float(rank or 0),
                snippet=snippet,
                breadcrumb=trail,
                parent_link=link,
                match="name" if named else "content",
            )
        )

    related: list[FileSearchHit] = []
    if semantic and offset == 0 and files_wanted:
        related = await _related_by_meaning(
            db, user, q, trails, exclude={h.file.id for h in hits},
            type=type, owner=owner, modified_after=modified_after, folder_id=folder_id,
        )

    within_trail = (await trails.of_folder(root))[0] if folder_id is not None else None
    return FileSearchResponse(
        query=q, hits=hits, folders=folder_hits, folder_breadcrumbs=folder_trails,
        has_more=has_more, related=related, within_trail=within_trail,
    )


async def _related_by_meaning(
    db: AsyncSession,
    user: User,
    q: str,
    trails: _Trails,
    *,
    exclude: set[uuid.UUID],
    type: str | None,
    owner: str,
    modified_after: datetime | None,
    folder_id: uuid.UUID | None,
    limit: int = 6,
) -> list[FileSearchHit]:
    """Files the AI search index finds for ``q`` that the word search
    didn't (WP-5.4). Needs AI search of your files on and a working
    embedder; otherwise nothing (word search already covered keywords)."""
    from app.custom_models import retrieval
    from app.files.drive_index import drive_settings
    from app.files.finder import FILE_TYPES, FileFilters

    if not drive_settings(user)["enabled"]:
        return []
    filters = FileFilters(
        type=type if type in FILE_TYPES else None,
        folder_id=folder_id,
        owner={"me": "me", "others": "shared"}.get(owner, "anyone"),
        modified_after=modified_after,
    )
    try:
        chunks = await retrieval.related_drive_hits(db, reader_id=user.id, query=q, filters=filters)
    except Exception:  # noqa: BLE001 — related results are a bonus, never an error
        logger.info("related-by-meaning search failed", exc_info=True)
        return []
    out: list[FileSearchHit] = []
    seen: set[uuid.UUID] = set(exclude)
    for c in chunks:
        if c.user_file_id in seen:
            continue
        seen.add(c.user_file_id)
        row = await db.get(UserFile, c.user_file_id)
        if row is None or row.trashed_at is not None:
            continue
        from app.chat.tools.search_my_files import _passage

        passage = _passage(c.text, c.filename)
        parent = await db.get(FileFolder, row.folder_id) if row.folder_id else None
        trail, link = await trails.of_folder(parent, owner_id=row.user_id)
        out.append(
            FileSearchHit(
                file=_file_to_response(row, caller=user),
                rank=float(c.score or 0),
                snippet=(passage[:200] + "…") if len(passage) > 200 else passage,
                breadcrumb=trail,
                parent_link=link,
                match="meaning",
            )
        )
        if len(out) >= limit:
            break
    return out


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
                "can_edit": g.can_edit,
                "can_comment": bool(g.can_comment or g.can_edit),
                "via_link": g.via_link_id is not None,
            }
        )
    return GrantsListResponse(
        grants=out,  # type: ignore[arg-type]
        can_share=True,
    )


async def _assert_can_comment_allowed(
    db: AsyncSession, *, resource_type: str, resource_id: uuid.UUID, can_comment: bool
) -> None:
    """Commenter (WP-6.6) is a role on Docs, Sheets and Whiteboards — the
    files that have comments."""
    if not can_comment:
        return
    from app.files.office import OFFICE_SOURCE_KINDS

    row = await db.get(UserFile, resource_id) if resource_type == "file" else None
    if row is None or row.source_kind not in OFFICE_SOURCE_KINDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Commenting is available on documents, spreadsheets and whiteboards.",
        )


async def _assert_can_edit_allowed(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
    can_edit: bool,
) -> None:
    """Reject ``can_edit=true`` on resources that don't support it.

    Stage 5.1 scopes write access to Drive Documents only. Folder
    grants and grants on non-document files (PDFs, images, ad-hoc
    uploads) get a 400 if the caller asks for editor mode — the
    UI hides the option for these but a hand-rolled API call would
    otherwise persist a flag the rest of the stack ignores.
    """
    if not can_edit:
        return
    if resource_type != "file":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Editor mode isn't available for folders. Share the "
                "individual document instead."
            ),
        )
    from app.files.office import OFFICE_SOURCE_KINDS

    from app.files.pdf_edit import is_editable_pdf

    row = await db.get(UserFile, resource_id)
    # Documents, spreadsheets and whiteboards take editors (WP-3.2), and
    # uploaded PDFs — fill in, annotate, reorganise (WP-6.5).
    if row is None or (row.source_kind not in OFFICE_SOURCE_KINDS and not is_editable_pdf(row)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Editor mode is only available on documents, spreadsheets, whiteboards and PDFs. "
                "Other file types stay read-only."
            ),
        )


@router.get("/users/search", response_model=UserSearchResponse)
async def search_users_for_share(
    q: str = Query(default="", max_length=80),
    limit: int = Query(default=20, ge=1, le=50),
    resource_type: str | None = Query(default=None),
    resource_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserSearchResponse:
    """User picker for the share modal.

    A blank query lists the people the caller already works with —
    members of their workspaces and people they've shared with before —
    not the whole instance. Typing (two characters or more) searches
    everyone by username or email, with ``%``/``_`` escaped. Emails come
    back only for an exact email match, so the picker can't be used to
    harvest every member's address (R-217, the rule /auth/users/directory
    already follows). Disabled accounts never appear. When
    ``resource_type`` and ``resource_id`` are passed, marks rows that
    already have a grant on that resource so the picker can disable them.
    """
    from app.chat.models import Workspace, WorkspaceShare

    q_norm = q.strip()
    base = select(User).where(User.id != user.id, User.disabled.is_(False))
    if not q_norm:
        from sqlalchemy import union

        my_ws = union(
            select(Workspace.id).where(Workspace.user_id == user.id),
            select(WorkspaceShare.workspace_id).where(
                WorkspaceShare.invitee_user_id == user.id,
                WorkspaceShare.status == "accepted",
            ),
        )
        known = union(
            select(Workspace.user_id).where(Workspace.id.in_(my_ws)),
            select(WorkspaceShare.invitee_user_id).where(
                WorkspaceShare.workspace_id.in_(my_ws),
                WorkspaceShare.status == "accepted",
            ),
            select(ResourceGrant.grantee_user_id).where(
                ResourceGrant.granted_by_user_id == user.id
            ),
        )
        stmt = base.where(User.id.in_(known))
    elif len(q_norm) < 2:
        return UserSearchResponse(results=[])
    else:
        escaped = q_norm.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        needle = f"{escaped}%"
        stmt = base.where(
            func.lower(User.username).like(needle, escape="\\")
            | func.lower(User.email).like(needle, escape="\\")
        )
    rows = (
        await db.execute(stmt.order_by(User.username.asc()).limit(limit))
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
                # Only when the caller typed that exact address.
                email=u.email if q_norm and q_norm.lower() == (u.email or "").lower() else None,
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
    # People who joined through a link don't use up the list (WP-6.6).
    if len([g for g in existing if g.via_link_id is None]) >= MAX_GRANTS_PER_RESOURCE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"This resource already has the maximum of "
                f"{MAX_GRANTS_PER_RESOURCE} grants. Revoke one before "
                f"adding another."
            ),
        )
    await _assert_can_edit_allowed(
        db,
        resource_type=rt,
        resource_id=rid,
        can_edit=payload.can_edit,
    )
    await _assert_can_comment_allowed(db, resource_type=rt, resource_id=rid, can_comment=payload.can_comment)
    joined = next((g for g in existing if g.grantee_user_id == grantee.id and g.via_link_id is not None), None)
    if joined is not None:
        # They came in through a link; sharing with them directly makes it
        # theirs to keep, with the role chosen here.
        joined.via_link_id = None
        joined.granted_by_user_id = user.id
        joined.can_copy = payload.can_copy
        joined.can_edit = payload.can_edit
        joined.can_comment = payload.can_comment
        await db.commit()
        return await _grants_list_response(db, resource_type=rt, resource_id=rid)
    grant = ResourceGrant(
        resource_type=rt,
        resource_id=rid,
        grantee_user_id=grantee.id,
        granted_by_user_id=user.id,
        can_copy=payload.can_copy,
        can_edit=payload.can_edit,
        can_comment=payload.can_comment,
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
    await _notify_grantee(
        db, rt, rid, grantee_id=grantee.id, sharer=user, can_edit=payload.can_edit, can_comment=payload.can_comment
    )
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


async def _notify_grantee(
    db: AsyncSession, rt: str, rid: uuid.UUID, *, grantee_id: uuid.UUID, sharer: User, can_edit: bool,
    can_comment: bool = False,
) -> None:
    """"Alex shared “Budget” with you" — in the inbox and as a push
    (WP-3.4). Opens the file's editor, or Shared with me."""
    from app.notifications.dispatch import notify_user

    url = "/files/shared"
    if rt == "file":
        row = await db.get(UserFile, rid)
        if row is None:
            return
        from app.files.office_router import editor_path
        from app.files.office_templates import office_title

        name = office_title(row)
        url = editor_path(row) or url
    else:
        folder = await db.get(FileFolder, rid)
        if folder is None:
            return
        name = folder.name
    verb = "can edit" if can_edit else "can comment on" if can_comment else "can view"
    await notify_user(
        user_id=grantee_id,
        category="invite",
        title=f"{sharer.username} shared “{name}” with you",
        body=f"You {verb} it.",
        url=url,
        tag=f"share-{rt}-{rid}",
        actor_user_id=sharer.id,
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
    if payload.can_edit is not None:
        # Validate before mutating so a rejected toggle doesn't
        # leave behind a partially-applied update.
        await _assert_can_edit_allowed(
            db,
            resource_type=rt,
            resource_id=rid,
            can_edit=payload.can_edit,
        )
        grant.can_edit = payload.can_edit
    if payload.can_comment is not None:
        await _assert_can_comment_allowed(db, resource_type=rt, resource_id=rid, can_comment=payload.can_comment)
        grant.can_comment = payload.can_comment
    if grant.via_link_id is not None:
        # The owner set this person's role themselves: it's theirs now, not
        # the link's (WP-6.6).
        grant.via_link_id = None
    downgraded = grant.grantee_user_id if payload.can_edit is False else None
    await db.commit()
    if downgraded is not None:
        # Open editing sockets go now, not at the next token refresh
        # (WP-3.2); a reconnect comes back read-only.
        from app.collab_internal import drop_user_soon

        drop_user_soon(downgraded)
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
    revoked = grant.grantee_user_id
    await db.delete(grant)
    await db.commit()
    from app.collab_internal import drop_user_soon

    drop_user_soon(revoked)
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
    revoked = list(
        (
            await db.execute(
                sa_delete(ResourceGrant)
                .where(ResourceGrant.resource_type == rt)
                .where(ResourceGrant.resource_id == rid)
                .returning(ResourceGrant.grantee_user_id)
            )
        ).scalars()
    )
    await db.commit()
    from app.collab_internal import drop_user_soon

    for uid in set(revoked):
        drop_user_soon(uid)
    return await _grants_list_response(
        db, resource_type=rt, resource_id=rid
    )


# --------------------------------------------------------------------
# Drive stage 5 — Copy-to-my-files for grantees
# --------------------------------------------------------------------
@router.post(
    "/files/{file_id:uuid}/copy-to-mine",
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

    # A Document, Sheet or Whiteboard copies as one — its editor state and
    # workbook, not just the export — so "Make a copy" stays editable
    # (WP-3.4). An owner's copy lands next to the original.
    from app.files.office_templates import copy_office_file, office_kind_of, office_title

    if office_kind_of(src) is not None:
        folder_id = None
        if is_owner and src.folder_id is not None:
            if not await _in_workspace_tree(db, src.folder_id, await _workspace_roots(db)):
                folder_id = src.folder_id
        clone = await copy_office_file(
            db, src, owner=user, folder_id=folder_id, title=f"{office_title(src)} (copy)"
        )
        await db.commit()
        await db.refresh(clone)
        return CopyToMineResponse(file=_file_to_response(clone, caller=user))

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
        # to look fresh anyway). Up to MAX_FILE_BYTES of disk I/O, so it
        # runs in a thread, not on the event loop (R-016).
        from shutil import copyfile

        await asyncio.to_thread(copyfile, src_abs, dest_abs)
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
        # Same bytes, same hashes (WP-7.1).
        content_sha256=src.content_sha256,
        sha1=src.sha1,
        md5=src.md5,
        verified_at=src.verified_at,
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
        role=(link.role or "view"),  # type: ignore[arg-type]
        has_password=link.password_hash is not None,
        keep_location=bool(link.keep_location),
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
    from app.auth.utils import ahash_password
    from app.files.link_roles import LinkRoleError, check_link_role

    try:
        await check_link_role(
            db, resource_type=resource_type, resource_id=resource_id, role=payload.role,
            access_mode=payload.access_mode,
        )
    except LinkRoleError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    expires_at: datetime | None = None
    if payload.expires_in_days is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(
            days=payload.expires_in_days
        )
    password_hash = await ahash_password(payload.password) if payload.password else None

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
        keep_location=payload.keep_location,
        role=payload.role,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    return link


@router.post(
    "/{file_id:uuid}/share-links",
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
    "/folders/{folder_id:uuid}/share-links",
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
    "/{file_id:uuid}/share-links", response_model=ShareLinkListResponse
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
    "/folders/{folder_id:uuid}/share-links", response_model=ShareLinkListResponse
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


@router.get("/share-links", response_model=OwnedShareLinksResponse)
async def list_my_share_links(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OwnedShareLinksResponse:
    """Every live link the caller made, with what it opens — the "Shared
    links" view, so a link can be found and revoked from Drive (R-208)."""
    from sqlalchemy import or_ as _or

    now = datetime.now(timezone.utc)
    rows = (
        (
            await db.execute(
                select(FileShareLink)
                .where(
                    FileShareLink.created_by == user.id,
                    FileShareLink.revoked_at.is_(None),
                    _or(FileShareLink.expires_at.is_(None), FileShareLink.expires_at > now),
                )
                .order_by(FileShareLink.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    out: list[OwnedShareLink] = []
    for link in rows:
        name: str | None = None
        trashed = False
        if link.resource_type == "file":
            f = await db.get(UserFile, link.resource_id)
            if f is not None:
                name, trashed = f.filename, f.trashed_at is not None
        elif link.resource_type == "album":
            from app.photos.album_models import Album

            a = await db.get(Album, link.resource_id)
            name = a.title if a is not None else None
        else:
            d = await db.get(FileFolder, link.resource_id)
            if d is not None:
                name, trashed = d.name, d.trashed_at is not None
        base = _link_to_response(link)
        out.append(
            OwnedShareLink(**base.model_dump(), resource_name=name, resource_trashed=trashed)
        )
    return OwnedShareLinksResponse(links=out)


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
        # People who joined through it lose that access now (WP-6.6), and
        # their open editors go.
        from app.collab_internal import drop_user_soon
        from app.files.link_roles import drop_link_grants

        gone = await drop_link_grants(db, link)
        await db.commit()
        for uid in gone:
            drop_user_soon(uid)
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
        # attachment" error. Besides your own files, anything you can
        # open — shared with you, or in a workspace you're in — can be
        # asked about (WP-3.5, Part C §6 P1).
        if (
            row is None
            or row.trashed_at is not None
            or row.user_id is None
            or (row.user_id != user.id and not await _can_still_open(db, row, user))
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

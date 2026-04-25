"""Public share-link routes.

Mounted at ``/s/*`` (outside ``/api``) so signed share URLs can be
opened directly from a browser without an auth token. Every handler
here is deliberately token-gated — the URL path *is* the credential,
and the optional password / ``invite`` mode add further gates on top.

Why a separate router:

* The endpoints must live outside any bearer-token requirement
  because share-link recipients are anonymous by construction.
* Keeping them in their own module makes the owner-side CRUD (in
  ``router.py`` under ``/api/files/{id}/share-links``) easier to
  reason about — everyone knows "this file sets ACLs, that file
  resolves them."
* The landing page at ``/s/:token`` lives in its own React layout
  (no sidebar / auth shell), so the 1:1 with a dedicated API
  prefix keeps the routing model simple.

Shape of the flow:

    GET /s/{token}/meta          → landing page UI decides what to show
    POST /s/{token}/unlock       → trade password for short-lived cookie-token
    GET /s/{token}/download      → stream the file blob
    GET /s/{token}/browse        → folder-share browser (folders only)

The ``unlock_token`` is a signed JWT that includes the link id and a
10-minute expiry. We don't use an HTTP-only cookie because the
browser-side share landing page is a plain SPA fetch and cookies
would bring origin + SameSite complexity we don't need.
"""
from __future__ import annotations

import logging
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    status,
)
from fastapi.responses import FileResponse as FastAPIFileResponse
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.utils import JWT_ALGORITHM, verify_password
from app.config import get_settings
from app.database import get_db
from app.files.models import (
    FileFolder,
    FileShareGrant,
    FileShareLink,
    UserFile,
)
from app.files.schemas import (
    BreadcrumbEntry,
    FileResponse,
    FolderResponse,
    ShareFolderBrowseResponse,
    ShareLinkMetaResponse,
    ShareLinkUnlockRequest,
    ShareLinkUnlockResponse,
)
from app.files.storage import absolute_path

logger = logging.getLogger("promptly.files.share")
settings = get_settings()

router = APIRouter()


# --------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------
# Short-lived unlock token TTL. Deliberately tight so a leaked cookie
# can't be replayed forever. The landing page re-prompts if it
# expires mid-session.
_UNLOCK_TTL = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _mint_unlock_token(link_id: uuid.UUID) -> str:
    payload = {
        "link": str(link_id),
        "exp": int((_now() + _UNLOCK_TTL).timestamp()),
        "iat": int(_now().timestamp()),
        "typ": "file_share_unlock",
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=JWT_ALGORITHM)


def _verify_unlock_token(token: str, expected_link_id: uuid.UUID) -> bool:
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "iat"]},
        )
    except JWTError:
        return False
    if payload.get("typ") != "file_share_unlock":
        return False
    if payload.get("link") != str(expected_link_id):
        return False
    return True


def _link_is_alive(link: FileShareLink) -> tuple[bool, str | None]:
    """Return ``(alive, reason)``. ``reason`` explains 410s."""
    if link.revoked_at is not None:
        return False, "revoked"
    if link.expires_at is not None and link.expires_at <= _now():
        return False, "expired"
    return True, None


async def _load_live_link(
    db: AsyncSession, token: str
) -> FileShareLink:
    row = (
        await db.execute(
            select(FileShareLink).where(FileShareLink.token == token)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found"
        )
    alive, reason = _link_is_alive(row)
    if not alive:
        # 410 Gone so the frontend can distinguish "never existed"
        # from "was intentionally taken down / expired". The
        # landing page surfaces a friendlier copy in each case.
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=f"Share link is no longer available ({reason})",
        )
    return row


async def _resolve_authed_user(
    request: Request, db: AsyncSession
) -> User | None:
    """Best-effort lookup of the logged-in Promptly user.

    Share-link endpoints *must not* require auth, so we can't reuse
    the standard ``get_current_user`` dependency (it 401s on missing
    tokens). This helper is the lightweight version: if the request
    happens to carry a valid bearer token we return the user;
    otherwise we return ``None`` and the caller enforces whatever
    gating the link specifies.
    """
    auth_header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    )
    if not auth_header:
        return None
    parts = auth_header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    raw_token = parts[1].strip()
    if not raw_token:
        return None

    from app.auth.utils import TokenError, decode_token

    try:
        payload = decode_token(raw_token, expected_type="access")
    except TokenError:
        return None
    try:
        user_id = uuid.UUID(payload["sub"])
    except (ValueError, KeyError):
        return None
    user = await db.get(User, user_id)
    if user is None or user.disabled or user.is_locked:
        return None
    token_tv = payload.get("tv", 0)
    if int(token_tv) != int(user.token_version):
        return None
    return user


async def _has_invite_grant(
    db: AsyncSession, link_id: uuid.UUID, user_id: uuid.UUID
) -> bool:
    existing = (
        await db.execute(
            select(FileShareGrant.id).where(
                FileShareGrant.link_id == link_id,
                FileShareGrant.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return existing is not None


async def _record_invite_grant(
    db: AsyncSession, link_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    grant = FileShareGrant(link_id=link_id, user_id=user_id)
    db.add(grant)
    try:
        await db.commit()
    except Exception:
        # Race with a parallel first-visit is fine; ``UNIQUE(link_id,
        # user_id)`` means the second insert gets dropped.
        await db.rollback()


async def _gate_link(
    request: Request,
    db: AsyncSession,
    link: FileShareLink,
    *,
    unlock_header: str | None,
) -> None:
    """Apply ``invite`` / password gates to an otherwise-alive link.

    ``invite`` mode:
      * Visitor must be an authenticated Promptly user.
      * First visit creates a ``FileShareGrant`` row; subsequent
        visits look it up and skip the nudge.

    Password mode (orthogonal to ``invite``):
      * Visitor must present a valid unlock token in the
        ``X-Share-Unlock`` header (obtained via ``POST /unlock``).
    """
    if link.access_mode == "invite":
        user = await _resolve_authed_user(request, db)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=(
                    "This share link requires a Promptly account. Sign in "
                    "and reopen the link."
                ),
            )
        if not await _has_invite_grant(db, link.id, user.id):
            await _record_invite_grant(db, link.id, user.id)

    if link.password_hash is not None:
        if unlock_header is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Password required",
            )
        if not _verify_unlock_token(unlock_header, link.id):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unlock token is invalid or expired",
            )


async def _bump_access(db: AsyncSession, link: FileShareLink) -> None:
    link.access_count += 1
    link.last_accessed_at = _now()
    try:
        await db.commit()
    except Exception:
        # Best-effort — never fail the response over an analytics
        # counter update.
        await db.rollback()


def _link_to_file(link: FileShareLink) -> str:
    """Static helper for share-resource assertions."""
    return link.resource_type


# --------------------------------------------------------------------
# Public endpoints
# --------------------------------------------------------------------
@router.get("/{token}/meta", response_model=ShareLinkMetaResponse)
async def get_share_meta(
    token: str,
    request: Request,
    x_share_unlock: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> ShareLinkMetaResponse:
    """Return the minimum info the landing page needs to render.

    We deliberately return less info when the link is password-gated
    and the visitor hasn't unlocked yet (no filename / size) so the
    URL itself can't be used to enumerate Drive contents. Once the
    password is supplied, follow-up ``meta`` calls that include the
    unlock header see the full metadata.
    """
    link = await _load_live_link(db, token)

    # ``requires_auth`` is surfaced even when the visitor is already
    # authed — the landing page uses it to decide whether to show the
    # "you're viewing as X" chip.
    requires_auth = link.access_mode == "invite"

    # Gate check, but tolerate the case where the landing page is
    # calling this endpoint *before* it has a password — we still
    # want to return the "needs password" meta instead of 401ing so
    # the UI knows what prompt to draw.
    needs_password = link.password_hash is not None
    unlocked = (
        needs_password
        and x_share_unlock is not None
        and _verify_unlock_token(x_share_unlock, link.id)
    )

    # Invite-mode ALWAYS requires an authed user even to see meta
    # (otherwise we'd leak token validity to any stranger). Password
    # mode still answers "yes, you need a password" to anonymous
    # callers so the UI can draw the prompt.
    if requires_auth:
        authed = await _resolve_authed_user(request, db)
        if authed is None:
            # Return a stripped meta so the landing page shows
            # "Sign in to continue" without hints about the file.
            return ShareLinkMetaResponse(
                resource_type=link.resource_type,  # type: ignore[arg-type]
                access_mode=link.access_mode,  # type: ignore[arg-type]
                requires_password=needs_password,
                requires_auth=True,
                expires_at=link.expires_at,
                revoked_at=link.revoked_at,
                created_at=link.created_at,
            )
        # Already authed — record the grant so `/download` doesn't
        # re-do it.
        if not await _has_invite_grant(db, link.id, authed.id):
            await _record_invite_grant(db, link.id, authed.id)

    if needs_password and not unlocked:
        return ShareLinkMetaResponse(
            resource_type=link.resource_type,  # type: ignore[arg-type]
            access_mode=link.access_mode,  # type: ignore[arg-type]
            requires_password=True,
            requires_auth=requires_auth,
            expires_at=link.expires_at,
            revoked_at=link.revoked_at,
            created_at=link.created_at,
        )

    # Fully unlocked — return the real filename/size/mime so the
    # landing page can render a preview.
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    if link.resource_type == "file":
        file = await db.get(UserFile, link.resource_id)
        if file is not None and file.trashed_at is None:
            filename = file.filename
            mime_type = file.mime_type
            size_bytes = file.size_bytes
    elif link.resource_type == "folder":
        folder = await db.get(FileFolder, link.resource_id)
        if folder is not None and folder.trashed_at is None:
            filename = folder.name

    return ShareLinkMetaResponse(
        resource_type=link.resource_type,  # type: ignore[arg-type]
        access_mode=link.access_mode,  # type: ignore[arg-type]
        requires_password=needs_password,
        requires_auth=requires_auth,
        expires_at=link.expires_at,
        revoked_at=link.revoked_at,
        created_at=link.created_at,
        filename=filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
    )


@router.post("/{token}/unlock", response_model=ShareLinkUnlockResponse)
async def unlock_share(
    token: str,
    payload: ShareLinkUnlockRequest,
    db: AsyncSession = Depends(get_db),
) -> ShareLinkUnlockResponse:
    link = await _load_live_link(db, token)
    if link.password_hash is None:
        # No password expected — return a fresh token anyway so the
        # frontend can treat the flow identically. Some ops folks
        # might add a password *after* the first visit, and the
        # frontend shouldn't care.
        return ShareLinkUnlockResponse(unlock_token=_mint_unlock_token(link.id))

    if not verify_password(payload.password, link.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Password is incorrect",
        )
    return ShareLinkUnlockResponse(unlock_token=_mint_unlock_token(link.id))


def _share_content_disposition(filename: str) -> str:
    # Same RFC 5987 pattern as the authed download endpoint, but
    # ``attachment`` is forced so a public link can't render a
    # malicious HTML doc inline.
    fallback = filename.encode("ascii", errors="replace").decode("ascii")
    fallback = fallback.replace('"', "_").replace("\\", "_")
    encoded = urllib.parse.quote(filename, safe="")
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{encoded}'


@router.get("/{token}/download")
async def download_share(
    token: str,
    request: Request,
    x_share_unlock: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> FastAPIFileResponse:
    link = await _load_live_link(db, token)
    if link.resource_type != "file":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This link points at a folder — use /browse instead",
        )
    await _gate_link(request, db, link, unlock_header=x_share_unlock)

    file = await db.get(UserFile, link.resource_id)
    if file is None or file.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Linked file no longer exists",
        )
    path = absolute_path(file.storage_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File data missing on disk",
        )
    await _bump_access(db, link)
    return FastAPIFileResponse(
        path=str(path),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": _share_content_disposition(file.filename),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )


async def _ancestors_contain(
    db: AsyncSession, node_id: uuid.UUID, root_id: uuid.UUID
) -> bool:
    """Walk up from ``node_id`` to see if ``root_id`` is on the path."""
    cursor_id: uuid.UUID | None = node_id
    hops = 0
    while cursor_id is not None and hops < 64:
        if cursor_id == root_id:
            return True
        folder = await db.get(FileFolder, cursor_id)
        if folder is None:
            return False
        cursor_id = folder.parent_id
        hops += 1
    return False


def _folder_dto(folder: FileFolder) -> FolderResponse:
    scope = "shared" if folder.user_id is None else "mine"
    return FolderResponse(
        id=folder.id,
        parent_id=folder.parent_id,
        name=folder.name,
        scope=scope,  # type: ignore[arg-type]
        created_at=folder.created_at,
        system_kind=folder.system_kind,
        updated_at=folder.updated_at,
        starred_at=folder.starred_at,
        trashed_at=folder.trashed_at,
    )


def _file_dto(f: UserFile) -> FileResponse:
    scope = "shared" if f.user_id is None else "mine"
    return FileResponse(
        id=f.id,
        folder_id=f.folder_id,
        filename=f.filename,
        mime_type=f.mime_type,
        size_bytes=f.size_bytes,
        scope=scope,  # type: ignore[arg-type]
        created_at=f.created_at,
        updated_at=f.updated_at,
        starred_at=f.starred_at,
        trashed_at=f.trashed_at,
    )


@router.get("/{token}/browse", response_model=ShareFolderBrowseResponse)
async def browse_share(
    token: str,
    request: Request,
    folder_id: uuid.UUID | None = Query(default=None),
    x_share_unlock: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> ShareFolderBrowseResponse:
    """Browse inside a folder share link.

    ``folder_id`` defaults to the link's root folder. Callers can
    traverse into descendants but never up; we enforce that by
    walking the ancestor chain and confirming the shared root is
    somewhere above the requested folder.
    """
    link = await _load_live_link(db, token)
    if link.resource_type != "folder":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This link points at a file — use /download instead",
        )
    await _gate_link(request, db, link, unlock_header=x_share_unlock)

    root = await db.get(FileFolder, link.resource_id)
    if root is None or root.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared folder no longer exists",
        )

    target = root
    if folder_id is not None and folder_id != root.id:
        sub = await db.get(FileFolder, folder_id)
        if sub is None or sub.trashed_at is not None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Folder not found",
            )
        # Scope check — the requested folder must live under the
        # shared root, otherwise a guessed UUID could escape the
        # share.
        if not await _ancestors_contain(db, sub.id, root.id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Folder not found",
            )
        target = sub

    # Breadcrumbs from ``target`` up to (but not past) the shared
    # root. We *don't* surface the real parent chain above the root
    # because that would leak names from outside the share.
    trail: list[BreadcrumbEntry] = []
    cursor: FileFolder | None = target
    hops = 0
    while cursor is not None and hops < 64:
        trail.append(BreadcrumbEntry(id=cursor.id, name=cursor.name))
        if cursor.id == root.id or cursor.parent_id is None:
            break
        cursor = await db.get(FileFolder, cursor.parent_id)
        hops += 1
    trail.reverse()

    children_folders = (
        (
            await db.execute(
                select(FileFolder)
                .where(
                    FileFolder.parent_id == target.id,
                    FileFolder.trashed_at.is_(None),
                )
                .order_by(FileFolder.name.asc())
            )
        )
        .scalars()
        .all()
    )
    children_files = (
        (
            await db.execute(
                select(UserFile)
                .where(
                    UserFile.folder_id == target.id,
                    UserFile.trashed_at.is_(None),
                )
                .order_by(UserFile.filename.asc())
            )
        )
        .scalars()
        .all()
    )

    await _bump_access(db, link)

    return ShareFolderBrowseResponse(
        folder=_folder_dto(target),
        breadcrumbs=trail,
        folders=[_folder_dto(f) for f in children_folders],
        files=[_file_dto(f) for f in children_files],
    )


@router.get("/{token}/file/{file_id}/download")
async def download_share_file(
    token: str,
    file_id: uuid.UUID,
    request: Request,
    x_share_unlock: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> FastAPIFileResponse:
    """Download an individual file inside a folder share."""
    link = await _load_live_link(db, token)
    if link.resource_type != "folder":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This link points at a file — use /download instead",
        )
    await _gate_link(request, db, link, unlock_header=x_share_unlock)

    file = await db.get(UserFile, file_id)
    if file is None or file.trashed_at is not None or file.folder_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )
    if not await _ancestors_contain(db, file.folder_id, link.resource_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )
    path = absolute_path(file.storage_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File data missing on disk",
        )
    await _bump_access(db, link)
    return FastAPIFileResponse(
        path=str(path),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": _share_content_disposition(file.filename),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )


__all__ = ["router"]

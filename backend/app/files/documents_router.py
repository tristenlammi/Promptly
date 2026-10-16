"""Drive Documents API.

A Drive Document is a ``UserFile`` row carrying
``source_kind="document"`` whose on-disk blob holds the *rendered*
HTML snapshot of a Y.js CRDT. The CRDT itself lives in
``document_state`` and is driven by the Hocuspocus collab service
(``/api/collab/<id>``). This router owns the non-websocket side:

* ``POST /api/documents`` — create a blank doc (empty Y.Doc + empty
  HTML blob), returns a ``FileResponse`` so the frontend can treat
  the new row like any other Drive file.
* ``GET /api/documents/{id}/collab-token`` — mint a 5-minute HS256
  JWT that the browser hands Hocuspocus as its auth token.
* ``POST /api/documents/{id}/snapshot`` — internal-only; called by
  Hocuspocus after each idle flush with the current Y.Doc bytes.
  Renders HTML + plain text, rewrites the file blob, updates the
  FTS index, bumps ``updated_at``.
* ``POST /api/documents/{id}/assets`` — upload inline media (image
  or audio) pasted / dropped inside a doc. The asset lives on a
  sibling ``UserFile`` row (``source_kind="document_asset"``,
  ``source_file_id=<doc>``) so it inherits the user's quota + auth
  path but never shows up in Drive listings.

Kept in its own router module (rather than piled onto ``files/router.py``)
so the API surface stays easy to reason about and the collab-side
dependencies (pycrdt, shared-secret auth) don't leak into the
generic Files endpoints.
"""
from __future__ import annotations

import asyncio

import hashlib
import hmac
import html
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse as FastAPIFileResponse
from jose import JWTError, jwt
from sqlalchemy import and_, delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, Field

from app.files.disk_guard import require_disk_room
from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import JWT_ALGORITHM
from app.config import get_settings
from app.database import get_db
from app.files.document_render import (
    extract_text_from_html,
    render_html_from_update,
    sanitize_document_html,
)
from app.files.generated_kinds import GeneratedKind
from app.files.models import (
    DocumentState,
    DocumentVersion,
    FileFolder,
    UserFile,
)
from app.files.quota import get_quota
from app.files.safety import (
    UnsafeUploadError,
    canonical_mime_for,
    sanitize_filename,
    sniff_and_validate,
    strip_image_metadata_in_place,
)
from app.files.schemas import (
    CollabTokenResponse,
    CollabTokenUser,
    DocumentAssetResponse,
    DocumentCreateRequest,
    DocumentVersionContent,
    DocumentVersionMeta,
    FileResponse as FileResponseSchema,
    ManualDocumentSaveRequest,
    Scope,
)
from app.files.storage import (
    MAX_FILE_BYTES,
    absolute_path,
    copy_stream_to_disk_async,
    delete_blob,
    ensure_bucket,
    storage_path_for,
)

logger = logging.getLogger("promptly.files.documents")
settings = get_settings()

router = APIRouter()


# --------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------
# Collab JWT lifetime. Short enough that a leaked token dies fast,
# long enough to absorb a reconnect storm. The client schedules a
# refresh a few seconds before expiry so a typing user never sees a
# disconnect.
COLLAB_TOKEN_TTL_SECONDS = 5 * 60

# Inline document asset size cap. Document images + audio are
# intentionally more generous than the default upload ceiling
# because a podcast clip in a doc can legitimately push past the
# 40 MB Drive ceiling — but we still cap it so a pasted full-length
# video can't blow up the DB.
DOCUMENT_ASSET_MAX_BYTES = 25 * 1024 * 1024

# Allowlist of MIME types the editor can inject inline. Everything
# else should go through the ordinary Drive upload path.
_DOCUMENT_ASSET_ALLOWED_PREFIXES = ("image/", "audio/")

# Default filename for a freshly-created document when the caller
# doesn't supply one.
_DEFAULT_DOCUMENT_TITLE = "Untitled document"


# --------------------------------------------------------------------
# Collab token helpers
# --------------------------------------------------------------------
def _mint_collab_token(*, document_id: uuid.UUID, user: User, perm: str, epoch: int = 0) -> tuple[str, int]:
    now = int(time.time())
    exp = now + COLLAB_TOKEN_TTL_SECONDS
    from app.auth.avatars import avatar_url_for

    payload: dict[str, Any] = {
        "sub": str(user.id),
        "type": "collab",
        "document_id": str(document_id),
        "perm": perm,
        "epoch": epoch,
        "name": user.username,
        # Chosen profile colour wins; the palette hash is the fallback so
        # cursors stay stable for users who never picked one.
        "color": user.avatar_color or _color_for_user(user.id),
        "avatar": avatar_url_for(user),
        "iat": now,
        "exp": exp,
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token, exp


# Palette pulled from the app's accent tokens. Stable per-user so
# the collaboration-cursor colour doesn't flicker between sessions.
# --------------------------------------------------------------------
# Inline asset URL signing
# --------------------------------------------------------------------
# Inline images / audio embedded inside a document get a signed URL
# on upload so ``<img src>`` / ``<audio src>`` works inside a
# browser session that authenticates via ``Authorization: Bearer``
# (those element-level requests can't attach custom headers, so
# the URL itself has to be the credential).
#
# The signature is an HMAC over ``"asset:<asset_id>:<doc_id>"`` —
# long-lived, stable, and only verifiable by someone who already
# had read access to the doc at the moment the asset was uploaded
# (because that's who got handed the signed URL to embed in the
# HTML / Y.Doc). Rotate ``SECRET_KEY`` to revoke every outstanding
# signature in one move.
#
# We deliberately do NOT include ``user_id`` in the HMAC so a
# second collaborator on the same document renders the same URL
# without the uploader's identity following the doc around.

# WP-4.6 (R-228): documents now store the *stable* asset path and readers
# get short-lived signed links (``app.files.doc_assets``). The permanent
# ``?sig=`` links above still verify, for content written before.
def _signed_asset_url(*, asset_id: uuid.UUID, document_id: uuid.UUID) -> str:
    from app.files.doc_assets import signed_url

    return signed_url(document_id, asset_id)


_COLLAB_COLOR_PALETTE = [
    "#D97757",  # brand accent
    "#4F46E5",  # indigo
    "#0EA5E9",  # sky
    "#10B981",  # emerald
    "#F59E0B",  # amber
    "#EF4444",  # red
    "#A855F7",  # purple
    "#14B8A6",  # teal
]


def _color_for_user(user_id: uuid.UUID) -> str:
    # Use the low bits of the UUID as a palette index — deterministic
    # and identically agreed by every backend process.
    idx = user_id.int % len(_COLLAB_COLOR_PALETTE)
    return _COLLAB_COLOR_PALETTE[idx]


# --------------------------------------------------------------------
# Row helpers — reuse the ACL / scope logic from the main files router
# --------------------------------------------------------------------
def _owner_for_scope(user: User, scope: Scope) -> uuid.UUID:
    """Return the ``user_id`` we should stamp on a new document.

    Documents always live in the caller's own pool — sharing
    happens after creation via the grant-modal flow. ``scope=shared``
    on creation is a stale concept from the legacy admin pool.
    """
    if scope == "shared":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "New documents are created in My files. Use the share modal "
                "to grant access after creation."
            ),
        )
    return user.id


def _can_write(owner_id: uuid.UUID | None, user: User) -> bool:
    """True iff ``user`` owns this row outright.

    Used for ownership-only write paths (creating a new document
    inside a parent folder — that's tied to the *folder's* owner,
    not the document, so grant-based edit access doesn't apply).
    For document-level write checks (collab token, manual save,
    asset upload) use :func:`can_write_document` from
    :mod:`app.files.sharing` instead — that one honours
    ``can_edit`` grants.
    """
    return owner_id is not None and owner_id == user.id


def _scope_of_for_caller(
    owner_id: uuid.UUID | None, caller: User
) -> Scope:
    if owner_id is not None and owner_id == caller.id:
        return "mine"
    return "shared"


async def _load_document(
    db: AsyncSession, document_id: uuid.UUID, user: User
) -> UserFile:
    """Resolve a document row the caller can at least read.

    Owner gets full access. A peer-to-peer grant on the document
    (or any ancestor folder) lets the caller open it read-only —
    the collab token endpoint downgrades them to ``perm="read"``.
    """
    row = await db.get(UserFile, document_id)
    if row is None or row.source_kind != GeneratedKind.DOCUMENT.value:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )
    if row.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document is in the trash"
        )
    if row.user_id is not None and row.user_id == user.id:
        return row
    # Grantee path — folder cascade is honoured.
    from app.files.sharing import (
        caller_grants_for_file,
        file_is_accessible_via_workspace,
    )

    grants = await caller_grants_for_file(db, row, user)
    if grants:
        return row
    # Workspace side-door: a collaborator on a shared workspace can open
    # any note / canvas backed by this document. Without it the backing
    # UserFile (owned by the note's creator) 404s for everyone else and
    # the editor shows "collaboration unavailable".
    if await file_is_accessible_via_workspace(db, row.id, user):
        return row
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
    )


def _file_to_response(f: UserFile, *, caller: User) -> FileResponseSchema:
    return FileResponseSchema(
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
        source_file_id=f.source_file_id,
    )


# --------------------------------------------------------------------
# Reusable creation helper — used by the route below *and* by the
# Workspaces items router (note creation), which composes it with a
# ``workspace_items`` row inside one transaction.
# --------------------------------------------------------------------
async def create_blank_document(
    db: AsyncSession,
    *,
    owner_id: uuid.UUID,
    folder_id: uuid.UUID | None,
    name: str | None,
) -> UserFile:
    """Lay down a blank Drive Document — ``UserFile`` + ``DocumentState``
    + a zero-byte HTML blob — flushed but **not committed** so the
    caller owns the surrounding transaction. Returns the new
    ``UserFile`` row. Cleans up the on-disk blob if a flush fails.

    No ACL / folder validation here — the caller is responsible for
    confirming ``owner_id`` may write into ``folder_id`` before calling.
    """
    # Seed the on-disk blob so preview + download work the moment the
    # document exists. The snapshot endpoint overwrites it as soon as
    # the first edit flushes through Hocuspocus.
    new_id = uuid.uuid4()
    rel_path = storage_path_for(owner_id, new_id, ".html")
    ensure_bucket(owner_id)
    abs_path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write("")

    title = (name or _DEFAULT_DOCUMENT_TITLE).rstrip(".")
    filename = title if title.lower().endswith(".html") else f"{title}.html"
    filename = sanitize_filename(filename)

    row = UserFile(
        id=new_id,
        user_id=owner_id,
        folder_id=folder_id,
        filename=filename,
        original_filename=filename,
        mime_type="text/html",
        size_bytes=0,
        storage_path=rel_path,
        source_kind=GeneratedKind.DOCUMENT.value,
        content_text=None,
    )
    db.add(row)

    # Flush so the parent ``files`` row exists before the child
    # ``document_state`` row references it. There's no ORM
    # ``relationship()`` wiring the two together (by design — the
    # collab service is the only writer of document_state and never
    # loads the UserFile), so SQLAlchemy's unit of work doesn't know
    # about the FK dependency and could otherwise flush the child first
    # and trip ``document_state_file_id_fkey``.
    try:
        await db.flush()
    except Exception:
        delete_blob(rel_path)
        raise

    # Empty Y.Doc state so the Hocuspocus Database extension returns
    # something instead of None on the very first fetch.
    db.add(DocumentState(file_id=new_id, yjs_update=b"", version=0))
    try:
        await db.flush()
    except Exception:
        delete_blob(rel_path)
        raise

    return row


# --------------------------------------------------------------------
# POST /api/documents — create a blank document
# --------------------------------------------------------------------
@router.post("", response_model=FileResponseSchema, status_code=status.HTTP_201_CREATED)
async def create_document(
    body: DocumentCreateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponseSchema:
    """Create an empty Drive Document.

    Lays down two rows atomically: the visible ``UserFile`` (with a
    zero-byte HTML blob on disk) and a ``DocumentState`` carrying an
    empty Y.Doc update so the first collab session has something to
    load from the Database extension.
    """
    owner_id = _owner_for_scope(user, body.scope)

    parent_folder: FileFolder | None = None
    if body.folder_id is not None:
        parent_folder = await db.get(FileFolder, body.folder_id)
        if parent_folder is None or not _can_write(parent_folder.user_id, user):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
            )
        if parent_folder.trashed_at is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot create a document inside a trashed folder",
            )

    row = await create_blank_document(
        db,
        owner_id=owner_id,
        folder_id=parent_folder.id if parent_folder else None,
        name=body.name,
    )

    try:
        await db.commit()
    except Exception:
        delete_blob(row.storage_path)
        raise
    await db.refresh(row)
    return _file_to_response(row, caller=user)


# --------------------------------------------------------------------
# "Open in Promptly Docs" — an editable document made from an upload
# (WP-4.3, Part C §3.7). The browser converts the file (mammoth, against
# the editor's own schema) and seeds the new document's state once; the
# original is never touched and stays linked through ``source_file_id``.
# --------------------------------------------------------------------
class DocumentImportRequest(BaseModel):
    source_file_id: uuid.UUID
    name: str | None = Field(default=None, max_length=200)


@router.post("/import", response_model=FileResponseSchema, status_code=status.HTTP_201_CREATED)
async def import_document(
    body: DocumentImportRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponseSchema:
    """A blank document next to the file it's made from (in your own folder;
    otherwise in My files), linked by ``source_file_id``. Seed it with
    ``POST /{id}/initial-state``."""
    from app.files.office_formats import office_ext
    from app.files.router import _in_workspace_tree, _load_readable_file, _workspace_roots

    src = await _load_readable_file(db, body.source_file_id, user)
    ext = os.path.splitext(src.filename or "")[1].lower()
    is_markdown = ext in (".md", ".markdown")
    if src.trashed_at is not None or (office_ext(src.filename) not in (".docx",) and not is_markdown):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only a Word (.docx) or Markdown (.md) file can be opened as a document.",
        )
    folder_id = None
    if src.user_id == user.id and src.folder_id is not None:
        if not await _in_workspace_tree(db, src.folder_id, await _workspace_roots(db)):
            folder_id = src.folder_id
    stem = (body.name or "").strip() or os.path.splitext(src.filename)[0] or "Imported document"
    if is_markdown:
        # Markdown converts here, with the same builder automations use
        # (tables, checklists, strike-through, images — R-229), and is
        # seeded straight away; Word converts in the browser.
        src_path = absolute_path(src.storage_path)
        raw = src_path.read_bytes()[: 5 * 1024 * 1024] if src_path.exists() else b""
        row = await document_from_markdown(
            db, user, name=stem, folder_id=folder_id, markdown=raw.decode("utf-8-sig", errors="replace")
        )
    else:
        row = await create_blank_document(db, owner_id=user.id, folder_id=folder_id, name=stem)
    row.source_file_id = src.id
    try:
        await db.commit()
    except Exception:
        delete_blob(row.storage_path)
        raise
    await db.refresh(row)
    return _file_to_response(row, caller=user)


async def document_from_markdown(
    db: AsyncSession, user: User, *, name: str, folder_id: uuid.UUID | None, markdown: str
) -> UserFile:
    """A new document with ``markdown`` as its content (tables, checklists,
    strike-through, images — R-229) — used by the .md import and by Convert
    with AI (WP-5.5). Flushed, not committed."""
    import base64

    from app.files.document_build import markdown_to_doc_update

    row = await create_blank_document(db, owner_id=user.id, folder_id=folder_id, name=name)
    update = await asyncio.to_thread(markdown_to_doc_update, markdown)
    html_text = await _merge_editor_state(db, row.id, base64.b64encode(update).decode())
    _write_html_atomically(absolute_path(row.storage_path), html_text)
    row.size_bytes = len(html_text.encode("utf-8"))
    row.content_text = extract_text_from_html(html_text) or None
    return row


class InitialStateRequest(BaseModel):
    # base64 Y.Doc update built in the browser from the converted file.
    yjs_state: str = Field(min_length=1, max_length=40 * 1024 * 1024)


@router.post("/{document_id}/initial-state", response_model=FileResponseSchema)
async def seed_document_state(
    document_id: uuid.UUID,
    body: InitialStateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponseSchema:
    """Give a brand-new document its first content — once. A document that
    already has a state (someone opened or typed in it) answers 409, so an
    imported file can never be seeded twice into a live document."""
    row = await _load_document(db, document_id, user)
    from app.files.sharing import can_write_document

    if not await can_write_document(db, row, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can't edit this document")
    ds = (
        await db.execute(select(DocumentState).where(DocumentState.file_id == row.id).with_for_update())
    ).scalar_one_or_none()
    if ds is not None and (ds.version or 0) > 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This document already has content.")
    html_text = await _merge_editor_state(db, row.id, body.yjs_state)
    plain_text = extract_text_from_html(html_text)
    abs_path = absolute_path(row.storage_path)
    _write_html_atomically(abs_path, html_text)
    row.size_bytes = len(html_text.encode("utf-8"))
    row.content_text = plain_text or None
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return _file_to_response(row, caller=user)


# --------------------------------------------------------------------
# GET /api/documents/{id}/collab-token — mint a short-lived JWT
# --------------------------------------------------------------------
@router.get("/{document_id}/collab-token", response_model=CollabTokenResponse)
async def get_collab_token(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CollabTokenResponse:
    row = await _load_document(db, document_id, user)
    from app.files.sharing import can_write_document

    # Write vs read is decided by the ``perm`` claim in the collab JWT, which
    # the Hocuspocus server enforces (readOnly for perm=="read"). A workspace
    # *viewer* reaches shared notes for reading, but must NOT get a write
    # token — so we resolve the caller's actual workspace ROLE here (owner /
    # admin / editor → write; viewer → read) rather than granting write to
    # any member. The same answer goes back as ``can_edit`` so the editor UI
    # stops guessing (R-218).
    # ``_load_document`` already gated read access, so a non-writer safely
    # falls through to a read-only token.
    can_edit = await can_write_document(db, row, user)
    perm = "write" if can_edit else "read"
    token, exp = _mint_collab_token(document_id=row.id, user=user, perm=perm)
    return CollabTokenResponse(
        token=token,
        expires_at=exp,
        can_edit=can_edit,
        user=CollabTokenUser(
            id=user.id,
            name=user.username,
            color=user.avatar_color or _color_for_user(user.id),
            avatar=user.avatar_url,
        ),
    )


# --------------------------------------------------------------------
# Version history capture (Phase 9)
# --------------------------------------------------------------------
# At most one *auto* (collab-path) version per document in this window —
# the collab server flushes every few idle seconds, so without a throttle
# an active editing session would spawn dozens of near-identical rows.
_AUTO_VERSION_MIN_INTERVAL_S = 180.0
# Keep at most this many versions per document; oldest auto rows pruned.
_MAX_VERSIONS_PER_DOC = 50


async def _capture_document_version(
    db: AsyncSession,
    *,
    file_id: uuid.UUID,
    html: str,
    plain_text: str | None,
    author_user_id: uuid.UUID | None,
    source: str,
) -> None:
    """Append a version row for ``file_id`` (best-effort; never raises).

    ``manual`` / ``restore`` sources always capture. ``auto`` (collab)
    captures only when the content changed AND the newest version is
    older than the throttle window. Prunes to ``_MAX_VERSIONS_PER_DOC``.
    """
    try:
        content_hash = hashlib.sha256(html.encode("utf-8")).hexdigest()
        latest = (
            await db.execute(
                select(DocumentVersion)
                .where(DocumentVersion.file_id == file_id)
                .order_by(DocumentVersion.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        if latest is not None and latest.content_hash == content_hash:
            return  # unchanged — nothing to record
        if source == "auto" and latest is not None:
            age = (
                datetime.now(timezone.utc) - latest.created_at
            ).total_seconds()
            if age < _AUTO_VERSION_MIN_INTERVAL_S:
                return  # too soon for another auto-snapshot

        db.add(
            DocumentVersion(
                file_id=file_id,
                html=html,
                plain_text=(plain_text or None),
                size_bytes=len(html.encode("utf-8")),
                content_hash=content_hash,
                author_user_id=author_user_id,
                source=source,
            )
        )
        await db.flush()

        # Prune oldest beyond the cap so history stays bounded.
        ids = (
            (
                await db.execute(
                    select(DocumentVersion.id)
                    .where(DocumentVersion.file_id == file_id)
                    .order_by(DocumentVersion.created_at.desc())
                    .offset(_MAX_VERSIONS_PER_DOC)
                )
            )
            .scalars()
            .all()
        )
        for old_id in ids:
            await db.execute(
                sa_delete(DocumentVersion).where(DocumentVersion.id == old_id)
            )
        await db.commit()
    except Exception:  # noqa: BLE001 — versioning must never break a save
        logger.exception("Failed to capture document version for %s", file_id)
        await db.rollback()


# --------------------------------------------------------------------
# POST /api/documents/{id}/snapshot — internal snapshot writer
# --------------------------------------------------------------------
def _verify_collab_internal_caller(authorization: str | None) -> None:
    """The Hocuspocus → backend snapshot call carries the internal token
    (``app.collab_internal``) — it used to be ``SECRET_KEY`` itself."""
    from app.collab_internal import verify_internal_caller

    verify_internal_caller(authorization)


def _constant_time_equal(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _write_html_atomically(path, html_text: str) -> None:
    """Write via a temp file and ``os.replace`` (R-233): a reader — preview,
    download, the share page — never sees a half-written snapshot, and a
    crash mid-write leaves the previous one intact."""
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".snap-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(html_text)
        # mkstemp makes it 0600; uploads are world-readable inside the
        # stack so nginx can serve them (WP-7.5).
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _write_rendered(row: UserFile, yjs_state: bytes) -> tuple[str, str]:
    """Render the Y.Doc to sanitised HTML, write the blob, refresh the row's
    size / search text. Empty documents render to empty (still valid) HTML.
    Doesn't commit."""
    html_text = sanitize_document_html(render_html_from_update(yjs_state))
    plain_text = extract_text_from_html(html_text)
    abs_path = absolute_path(row.storage_path)
    _write_html_atomically(abs_path, html_text)
    try:
        size = abs_path.stat().st_size
    except OSError:
        size = len(html_text.encode("utf-8"))
    row.size_bytes = size
    row.content_text = plain_text or None
    row.updated_at = datetime.now(timezone.utc)
    return html_text, plain_text


async def rerender_stale_documents(db: AsyncSession, *, limit: int = 200) -> int:
    """Re-render documents whose live state is newer than their HTML.

    The collab server posts a snapshot after edits; one that never arrived
    (the backend down for an update, collab killed) left preview, download
    and search on old text until the next edit (R-249). Daily backstop.
    """
    from datetime import timedelta

    from sqlalchemy import func

    rows = (
        await db.execute(
            select(UserFile, DocumentState.yjs_update)
            .join(DocumentState, DocumentState.file_id == UserFile.id)
            .where(
                UserFile.source_kind == GeneratedKind.DOCUMENT.value,
                UserFile.trashed_at.is_(None),
                func.length(DocumentState.yjs_update) > 0,
                DocumentState.updated_at > UserFile.updated_at + timedelta(minutes=2),
            )
            .limit(limit)
        )
    ).all()
    n = 0
    for row, state in rows:
        try:
            _write_rendered(row, state)
            n += 1
        except Exception:  # noqa: BLE001 — one bad doc mustn't stop the sweep
            logger.warning("re-render failed for document %s", row.id, exc_info=True)
    await db.commit()
    return n


# Mounted at ``/api/internal/documents`` (nginx: 404 from outside) — it
# was under ``/api/documents``, reachable through the public catch-all.
internal_router = APIRouter()


@internal_router.post(
    "/{document_id}/snapshot",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def write_snapshot(
    document_id: uuid.UUID,
    request: Request,
    background: BackgroundTasks,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Persist a rendered HTML + FTS snapshot of the current Y.Doc.

    Called by the Hocuspocus collab service with the binary Y.Doc
    bytes in the request body, authenticated by the internal token on
    an ``/api/internal`` path nginx doesn't serve from outside.
    """
    _verify_collab_internal_caller(authorization)

    row = await db.get(UserFile, document_id)
    if row is None or row.source_kind != GeneratedKind.DOCUMENT.value:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )

    body = await request.body()
    if not body:
        # Empty body == no update to apply. Treat as a no-op rather
        # than a 400 so a startup flush with an empty doc is fine.
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    html_text, plain_text = _write_rendered(row, body)
    await db.commit()

    # Capture a version (throttled + deduped inside). The collab POST is
    # authenticated by the internal bearer, not a user, so authorship is
    # unknown here → NULL author.
    await _capture_document_version(
        db,
        file_id=document_id,
        html=html_text,
        plain_text=plain_text,
        author_user_id=None,
        source="auto",
    )

    # If this document backs a workspace note, (re)index it so workspace
    # chats stay grounded in the note's latest content. Local imports keep
    # the workspace layer out of the generic documents import graph.
    from app.chat.models import WorkspaceItem

    note_item = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.ref_id == document_id,
                WorkspaceItem.kind == "note",
            )
        )
    ).scalars().first()
    if note_item is not None:
        from app.workspaces import reindex
        from app.workspaces.knowledge import index_note_for_workspace

        # Coalesced: one re-embed after typing pauses, not one per snapshot
        # (R-233). The hash check inside skips it if nothing changed.
        reindex.schedule(
            index_note_for_workspace,
            note_item.workspace_id,
            note_item.id,
            delay=reindex.NOTE_DEBOUNCE_SECONDS,
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# POST /api/documents/{id}/save — owner-side manual snapshot
# --------------------------------------------------------------------
async def _merge_editor_state(db: AsyncSession, file_id: uuid.UUID, b64: str) -> str:
    """Merge an editor's CRDT state into ``document_state``; return its HTML.

    The editor's state descends from what it synced from the server, so a
    merge adds its local edits and nothing else. The collab server merges
    on store too, and pulls these edits into the live document the next
    time it saves.
    """
    import base64
    import binascii

    from pycrdt import Doc

    try:
        incoming = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad editor state") from e
    ds = (
        await db.execute(
            select(DocumentState).where(DocumentState.file_id == file_id).with_for_update()
        )
    ).scalar_one_or_none()
    doc = Doc()
    try:
        if ds is not None and ds.yjs_update:
            doc.apply_update(ds.yjs_update)
        doc.apply_update(incoming)
    except Exception as e:  # noqa: BLE001 — pycrdt raises plain errors
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad editor state") from e
    merged = doc.get_update()
    if ds is None:
        db.add(DocumentState(file_id=file_id, yjs_update=merged, version=1))
    else:
        ds.yjs_update = merged
        ds.version = (ds.version or 0) + 1
        ds.updated_at = datetime.now(timezone.utc)
    return render_html_from_update(merged)


@router.post(
    "/{document_id}/save",
    response_model=FileResponseSchema,
)
async def manual_save_document(
    document_id: uuid.UUID,
    body: ManualDocumentSaveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponseSchema:
    """Persist the editor's current HTML straight to the file blob.

    Authenticated by the standard user JWT (not the internal collab
    bearer) so the owner can save explicitly without waiting on the
    Hocuspocus debounce. Useful as both an explicit "Save now"
    affordance AND a fallback when the WS pipeline is misbehaving
    (Cloudflare tunnel, stopped collab container, etc.) — the
    typical symptom there is the file silently staying at 0 bytes
    because the collab snapshot path never fires.

    Re-runs the same sanitiser as the collab snapshot endpoint so a
    hostile client can't smuggle extra HTML through the side door.
    Available to the owner and any grantee whose grant carries
    ``can_edit=true``; read-only grantees still get a 403 here and
    the Save button stays hidden in the UI for them.
    """
    row = await _load_document(db, document_id, user)
    from app.files.sharing import can_write_document

    if not await can_write_document(db, row, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have write access to this document",
        )

    if body.epoch is not None and body.epoch != (row.collab_epoch or 0):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This document was restored to an earlier version since you opened it — reload to continue.",
        )
    if body.yjs_state:
        html_text = await _merge_editor_state(db, row.id, body.yjs_state)
    else:
        html_text = sanitize_document_html(body.html or "")
    plain_text = extract_text_from_html(html_text)

    abs_path = absolute_path(row.storage_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(html_text)
    try:
        size = abs_path.stat().st_size
    except OSError:
        size = len(html_text.encode("utf-8"))

    row.size_bytes = size
    row.content_text = plain_text or None
    row.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(row)

    # Explicit saves always version (dedup still skips a no-op re-save).
    # ``source`` lets a client-side restore tag its resulting save.
    await _capture_document_version(
        db,
        file_id=document_id,
        html=html_text,
        plain_text=plain_text,
        author_user_id=user.id,
        source="restore" if body.source == "restore" else "manual",
    )
    return _file_to_response(row, caller=user)


# --------------------------------------------------------------------
# GET /api/documents/{id}/versions — list version history
# --------------------------------------------------------------------
@router.get(
    "/{document_id}/versions",
    response_model=list[DocumentVersionMeta],
)
async def list_document_versions(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[DocumentVersionMeta]:
    """Version metadata (no HTML), newest first. Readable by anyone who
    can read the document."""
    row = await _load_document(db, document_id, user)
    versions = (
        (
            await db.execute(
                select(DocumentVersion)
                .where(DocumentVersion.file_id == row.id)
                .order_by(DocumentVersion.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    # Resolve author usernames in one pass.
    author_ids = {v.author_user_id for v in versions if v.author_user_id}
    names: dict[uuid.UUID, str] = {}
    if author_ids:
        rows = (
            await db.execute(
                select(User.id, User.username).where(User.id.in_(author_ids))
            )
        ).all()
        names = {uid: uname for uid, uname in rows}
    return [
        DocumentVersionMeta(
            id=v.id,
            created_at=v.created_at,
            size_bytes=v.size_bytes,
            source=v.source,
            author_username=(
                names.get(v.author_user_id) if v.author_user_id else None
            ),
            preview=(v.plain_text or "")[:160],
        )
        for v in versions
    ]


# --------------------------------------------------------------------
# GET /api/documents/{id}/versions/{version_id} — full version HTML
# --------------------------------------------------------------------
@router.get(
    "/{document_id}/versions/{version_id}",
    response_model=DocumentVersionContent,
)
async def get_document_version(
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocumentVersionContent:
    """Full sanitised HTML of one version (for preview + restore)."""
    row = await _load_document(db, document_id, user)
    version = await db.get(DocumentVersion, version_id)
    if version is None or version.file_id != row.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Version not found"
        )
    return DocumentVersionContent(
        id=version.id,
        created_at=version.created_at,
        html=version.html,
    )


# --------------------------------------------------------------------
# GET /api/documents/{id}/download — format-aware download
# --------------------------------------------------------------------
def _document_download_filename(stored: str, *, extension: str) -> str:
    """Pick a download filename for the given format.

    The stored filename is ``<title>.html`` (we coerce ``.html`` on
    create + rename). Strip the trailing ``.html`` (if any) and tack
    on the requested extension so the browser's "Save as" dialog
    pre-fills the right name.
    """
    base = stored
    lower = base.lower()
    if lower.endswith(".html"):
        base = base[: -len(".html")]
    elif lower.endswith(".htm"):
        base = base[: -len(".htm")]
    base = base or "document"
    return f"{base}{extension}"


async def _current_document_state(db: AsyncSession, row: UserFile) -> bytes | None:
    """The document's Y.Doc as it is now: the open collab room's (newer while
    its debounced store hasn't run — a page-setup change made a second ago
    must reach the PDF), else ``document_state``."""
    from app import collab_internal

    live = await collab_internal.live_state(str(row.id))
    if live:
        return live
    ds = await db.get(DocumentState, row.id)
    return bytes(ds.yjs_update) if ds is not None and ds.yjs_update else None


async def _current_document_html(
    db: AsyncSession, row: UserFile, state: bytes | None = None
) -> str:
    """The document as it is now: rendered from its current state when
    there is one, else the snapshot blob (an empty document is "")."""
    if state is None:
        state = await _current_document_state(db, row)
    if state:
        try:
            return await asyncio.to_thread(render_html_from_update, state)
        except Exception:  # noqa: BLE001 — fall back to the last snapshot
            logger.warning("export: couldn't render %s from its state", row.id, exc_info=True)
    abs_path = absolute_path(row.storage_path)
    try:
        return abs_path.read_text(encoding="utf-8") if abs_path.exists() else ""
    except OSError:
        return ""


_ASSET_SRC_RE = re.compile(
    r"""src=(["'])/api/documents/(?P<doc>[0-9a-f-]{36})/assets/(?P<asset>[0-9a-f-]{36})(?:\?[^"']*)?\1""",
    re.I,
)
_MAX_INLINE_BYTES = 40 * 1024 * 1024


async def _inline_document_images(db: AsyncSession, row: UserFile, html_text: str) -> str:
    """Swap this document's signed image URLs for ``data:`` URIs so an
    exported page or PDF carries its pictures (the PDF renderer refuses
    every external fetch, so images used to vanish — R-219). Only assets
    of *this* document are read; the caller was already allowed to export
    it, and a link's query string (old ``?sig=``, a short-lived one, or
    none — R-228) doesn't matter."""
    import base64

    budget = _MAX_INLINE_BYTES
    out: list[str] = []
    last = 0
    for m in _ASSET_SRC_RE.finditer(html_text or ""):
        out.append(html_text[last : m.start()])
        last = m.end()
        replacement = m.group(0)
        try:
            doc_id, asset_id = uuid.UUID(m["doc"]), uuid.UUID(m["asset"])
            asset = await db.get(UserFile, asset_id)
            if (
                doc_id == row.id
                and asset is not None
                and asset.source_kind == GeneratedKind.DOCUMENT_ASSET.value
                and asset.source_file_id == row.id
                and (asset.mime_type or "").startswith("image/")
                and asset.size_bytes <= budget
            ):
                data = await asyncio.to_thread(absolute_path(asset.storage_path).read_bytes)
                budget -= len(data)
                replacement = f'src="data:{canonical_mime_for(asset.filename)};base64,{base64.b64encode(data).decode()}"'
        except Exception:  # noqa: BLE001 — a missing image just stays a link
            pass
        out.append(replacement)
    out.append(html_text[last:])
    return "".join(out)


_EXPORT_CSS = """
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 16px;
       line-height: 1.6; color: #1f1f1f; max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem; }
h1, h2, h3 { line-height: 1.25; } img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ccc; padding: .35rem .6rem; }
th { background: #f4f4f4; } pre { background: #f6f6f6; padding: .75rem 1rem; overflow-x: auto; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; } blockquote { border-left: 3px solid #ccc;
       margin-left: 0; padding-left: 1rem; color: #555; }
ul[data-type="taskList"] { list-style: none; padding-left: .25rem; }
li[data-type="taskItem"][data-checked="true"] > p::before { content: "☑ "; }
li[data-type="taskItem"][data-checked="false"] > p::before { content: "☐ "; }
.doc-callout { border-left: 4px solid #38bdf8; background: #f0f9ff; padding: .5rem 1rem; border-radius: 6px; }
.doc-callout[data-variant="warning"] { border-left-color: #f59e0b; background: #fffbeb; }
.doc-callout[data-variant="success"] { border-left-color: #10b981; background: #ecfdf5; }
.doc-callout[data-variant="danger"] { border-left-color: #f43f5e; background: #fff1f2; }
figure.doc-figure { margin: 1rem 0; text-align: center; } figure.doc-figure[data-align="left"] { text-align: left; }
figure.doc-figure[data-align="right"] { text-align: right; }
figcaption { font-size: .85em; color: #666; font-style: italic; margin-top: .35rem; }
.doc-page-break { page-break-after: always; break-after: page; height: 0; }
.doc-math { font-family: "Latin Modern Math", "Cambria Math", serif; }
div.doc-math { display: block; text-align: center; margin: .75rem 0; }
.doc-columns { display: flex; gap: 1.5rem; } .doc-column { flex: 1; }
@media print { body { margin: 0; max-width: none; } }
"""


def _html_page(fragment: str, *, title: str) -> str:
    return (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n"
        f"<title>{html.escape(title or 'Document')}</title>\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n"
        f"<style>{_EXPORT_CSS}</style>\n</head>\n<body>\n{fragment}\n</body>\n</html>\n"
    )


_TASK_ITEM_RE = re.compile(
    r"""<li(?P<attrs>[^>]*\bdata-type=(["'])taskItem\2[^>]*)>""", re.I
)


def _mark_task_items(html_text: str) -> str:
    """Put a literal ``[x]`` / ``[ ]`` at the start of each task item so the
    Markdown keeps checkbox state (markdownify flattened it to "- item")."""

    def sub(m: re.Match) -> str:
        checked = re.search(r"""data-checked=(["'])true\1""", m["attrs"], re.I) is not None
        return f"<li{m['attrs']}>{_TASK_DONE if checked else _TASK_OPEN} "

    return _TASK_ITEM_RE.sub(sub, html_text)


# Placeholders markdownify won't escape; swapped for ``[x]`` / ``[ ]`` after.
_TASK_DONE = "PROMPTLYTASKDONE"
_TASK_OPEN = "PROMPTLYTASKOPEN"
_BARE_IMG_RE = re.compile(r"(<img\b[^>]*>)", re.I)


def _html_to_markdown(html_text: str) -> str:
    """Convert sanitised document HTML to GitHub-flavoured Markdown."""
    if not html_text:
        return ""
    html_text = _mark_task_items(html_text)
    # An image is a block in the editor; give it its own line.
    html_text = _BARE_IMG_RE.sub(r"<p>\1</p>", html_text)
    # ``markdownify`` defaults to "underscore for emphasis", which
    # diffs noisily against editors that emit ``*`` (most of them).
    # Pinning the literal asterisk keeps the output stable across
    # users + platforms. ``heading_style="ATX"`` produces ``#``
    # prefixes which are far more readable than the default
    # underline style.
    from markdownify import markdownify as md  # local import: optional dep

    out = md(
        html_text,
        heading_style="ATX",
        strong_em_symbol="*",
        bullets="-",
    )
    return out.replace(_TASK_DONE, "[x]").replace(_TASK_OPEN, "[ ]")


@router.get("/{document_id}/page-setup")
async def get_page_setup(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """The document's page setup (WP-6.4) — for a .docx made without the
    editor open. The editor itself reads it from the Y.Doc."""
    from app.files import page_setup

    row = await _load_document(db, document_id, user)
    return page_setup.from_update(await _current_document_state(db, row)).to_dict()


@router.get("/{document_id}/download")
async def download_document(
    document_id: uuid.UUID,
    format: str = Query(
        default="html",
        pattern="^(html|md|pdf|fragment)$",
        description="Output format: html (default, a standalone page), md, pdf, or fragment.",
    ),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Download the document in the requested format.

    Routes off the *current* HTML blob on disk (so the export sees
    whatever was last persisted by the collab snapshot or manual
    save). ``format=html`` returns the blob as-is; ``md`` runs it
    through ``markdownify``; ``pdf`` renders via WeasyPrint. Every
    response carries a ``Content-Disposition: attachment`` so the
    browser saves the file rather than rendering it inline (avoids
    a half-styled HTML page taking over the tab).
    """
    row = await _load_document(db, document_id, user)
    # Rendered from the live state, not the on-disk snapshot, which lags
    # the editor by the collab debounce — a download right after typing
    # used to miss the last few seconds (R-219).
    state = await _current_document_state(db, row)
    html_text = await _current_document_html(db, row, state)

    fmt = format.lower()
    if fmt == "md":
        body = _html_to_markdown(html_text).encode("utf-8")
        filename = _document_download_filename(row.filename, extension=".md")
        media_type = "text/markdown; charset=utf-8"
    elif fmt == "pdf":
        # WeasyPrint under the document's page setup (WP-6.4).
        from app.files import page_setup
        from app.files.pdf_export import PdfRenderError, build_pdf_html, render_pdf

        inlined = await _inline_document_images(db, row, html_text)
        page_html = build_pdf_html(
            inlined, page_setup.from_update(state), title=os.path.splitext(row.filename)[0]
        )
        try:
            body = await render_pdf(page_html)
        except PdfRenderError as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(exc)) from exc
        filename = _document_download_filename(row.filename, extension=".pdf")
        media_type = "application/pdf"
    elif fmt == "fragment":
        # The bare sanitised fragment — what the browser's .docx export
        # builds from (WP-4.3). Images keep their signed URLs.
        body = html_text.encode("utf-8")
        filename = _document_download_filename(row.filename, extension=".html")
        media_type = "text/html; charset=utf-8"
    else:
        # A standalone page: doctype, charset, title, a readable print
        # stylesheet, and images inlined so it works offline (R-219).
        inlined = await _inline_document_images(db, row, html_text)
        body = _html_page(inlined, title=os.path.splitext(row.filename)[0]).encode("utf-8")
        filename = _document_download_filename(row.filename, extension=".html")
        media_type = "text/html; charset=utf-8"

    # Minimal RFC 5987 escape so a non-ASCII filename round-trips.
    # Falls back to a plain ASCII name when nothing exotic is in the
    # title — keeps the header readable.
    ascii_safe = filename.encode("ascii", "replace").decode("ascii")
    disposition = f'attachment; filename="{ascii_safe}"'
    if filename != ascii_safe:
        from urllib.parse import quote

        disposition = (
            f'attachment; filename="{ascii_safe}"; '
            f"filename*=UTF-8''{quote(filename)}"
        )

    return Response(
        content=body,
        media_type=media_type,
        headers={
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            # Don't cache the export — the underlying document
            # changes constantly while editing, and a cached HTML/MD
            # would lie about the current state.
            "Cache-Control": "private, no-store",
        },
    )


# --------------------------------------------------------------------
# POST /api/documents/{id}/assets — inline media upload
# --------------------------------------------------------------------
@router.post(
    "/{document_id}/assets",
    response_model=DocumentAssetResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document_asset(
    document_id: uuid.UUID,
    request: Request,
    file: UploadFile,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),  # WP-7.2
) -> DocumentAssetResponse:
    """Upload an inline image or audio clip for a document.

    Creates a hidden sibling ``UserFile`` row so the asset gets
    storage quota accounting + auth gating for free, then returns
    the ``/api/files/{id}/download`` URL the TipTap node will use
    as its ``src``.
    """
    document = await _load_document(db, document_id, user)
    from app.files.sharing import can_write_document

    if not await can_write_document(db, document, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have write access to this document",
        )

    try:
        clean_name = sanitize_filename(file.filename)
    except UnsafeUploadError as e:
        await file.close()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    ext = os.path.splitext(clean_name)[1].lower()
    declared_mime = (file.content_type or "").lower()
    if not any(
        declared_mime.startswith(prefix)
        for prefix in _DOCUMENT_ASSET_ALLOWED_PREFIXES
    ):
        await file.close()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Only image and audio assets can be embedded inline. "
                "Upload other files to Drive directly instead."
            ),
        )

    # Storage cap pre-check — document assets count against the
    # *owner's* quota (the asset row is created with
    # ``user_id=document.user_id``). When the uploader is the owner
    # this is just ``user``; when an editor-grantee uploads, we
    # have to fetch the owner record so the cap check matches the
    # bucket the bytes will actually land in.
    if document.user_id is not None:
        owner = (
            user
            if document.user_id == user.id
            else await db.get(User, document.user_id)
        )
        if owner is None:
            await file.close()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document owner is missing",
            )
        quota = await get_quota(db, owner)
        if quota.cap_bytes is not None and quota.used_bytes >= quota.cap_bytes:
            await file.close()
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="You've reached your storage limit",
            )

    new_id = uuid.uuid4()
    rel_path = storage_path_for(document.user_id, new_id, ext)
    ensure_bucket(document.user_id)

    try:
        size = await copy_stream_to_disk_async(
            file.file, rel_path, size_limit=min(DOCUMENT_ASSET_MAX_BYTES, MAX_FILE_BYTES)
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                "This asset is too large to embed inline. "
                f"The maximum is {DOCUMENT_ASSET_MAX_BYTES // (1024 * 1024)} MB."
            ),
        )
    finally:
        await file.close()

    if size == 0:
        delete_blob(rel_path)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Upload was empty"
        )

    abs_path = absolute_path(rel_path)
    try:
        canonical_mime = await asyncio.to_thread(
            sniff_and_validate,
            abs_path,
            declared_filename=clean_name,
            declared_mime=declared_mime,
        )
    except UnsafeUploadError as e:
        delete_blob(rel_path)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    if not any(
        canonical_mime.startswith(prefix)
        for prefix in _DOCUMENT_ASSET_ALLOWED_PREFIXES
    ):
        delete_blob(rel_path)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded file is not an image or audio asset",
        )

    # A picture browsers can't show (a HEIC from an iPhone, a TIFF) is kept
    # in the document as a JPEG (WP-7.3); one Pillow can't read is refused.
    from app.files.imaging import BROWSER_IMAGE_MIMES, to_jpeg_in_place

    if canonical_mime.startswith("image/") and canonical_mime not in BROWSER_IMAGE_MIMES:
        try:
            await asyncio.to_thread(to_jpeg_in_place, abs_path)
        except Exception:  # noqa: BLE001 — Pillow raises broadly on odd files
            delete_blob(rel_path)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="That picture can't go in a document. Save it as a JPEG or PNG first.",
            )
        canonical_mime = "image/jpeg"
        clean_name = os.path.splitext(clean_name)[0] + ".jpg"

    # Images in a document are served by a signed URL that outlives
    # unsharing and travels in exports — treat them as public: drop their
    # metadata (losslessly, keeping orientation), falling back to a
    # re-encode if that fails.
    from app.files import egress

    try:
        if not (
            canonical_mime in egress.STRIPPABLE_MIMES
            and await asyncio.to_thread(egress.strip_in_place, abs_path)
        ):
            await asyncio.to_thread(strip_image_metadata_in_place, abs_path, canonical_mime)
    except UnsafeUploadError as e:
        delete_blob(rel_path)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        delete_blob(rel_path)
        raise
    try:
        size = abs_path.stat().st_size
    except OSError:
        pass

    row = UserFile(
        id=new_id,
        user_id=document.user_id,
        # Never inside a folder: an asset in the document's folder stayed
        # behind when the document moved, and got trashed and purged with
        # that folder while the document lived on with broken images
        # (R-027). Assets follow their document via ``source_file_id``.
        folder_id=None,
        filename=clean_name,
        original_filename=clean_name,
        mime_type=canonical_mime,
        size_bytes=size,
        storage_path=rel_path,
        source_kind=GeneratedKind.DOCUMENT_ASSET.value,
        source_file_id=document.id,
    )
    from app.files.blobstore import hash_into

    await hash_into(row)  # after the strip — these are the bytes kept
    db.add(row)
    try:
        await db.commit()
    except Exception:
        delete_blob(rel_path)
        raise
    await db.refresh(row)

    # Sign the asset URL so ``<img src>`` / ``<audio src>`` elements
    # inside the TipTap editor resolve without needing a bearer
    # header on each element-level request. The URL is embedded
    # directly into the document's Y.Doc / HTML snapshot, so any
    # later collaborator viewing the doc renders the same asset via
    # the same signed URL.
    from app.files.doc_assets import stable_path

    return DocumentAssetResponse(
        id=row.id,
        filename=row.filename,
        mime_type=row.mime_type,
        size_bytes=row.size_bytes,
        # What the document stores: a path, never a credential (R-228).
        url=stable_path(document.id, row.id),
        display_url=_signed_asset_url(asset_id=row.id, document_id=document.id),
    )


# --------------------------------------------------------------------
# POST /api/documents/asset-links — short-lived links for readers (R-228)
# --------------------------------------------------------------------
class AssetLinksRequest(BaseModel):
    # Asset URLs as a document holds them (path, with or without a query).
    urls: list[str] = Field(max_length=300)


@router.post("/asset-links")
async def asset_links(
    body: AssetLinksRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Signed, short-lived links for a document's images and audio — for
    anyone who can open the document they belong to. Unknown, foreign or
    trashed assets are simply left out."""
    from app.files.doc_assets import ASSET_URL_RE, signed_url

    out: dict[str, str] = {}
    readable: dict[uuid.UUID, bool] = {}
    for url in body.urls:
        m = ASSET_URL_RE.search(url or "")
        if not m:
            continue
        try:
            doc_id, asset_id = uuid.UUID(m["doc"]), uuid.UUID(m["asset"])
        except ValueError:
            continue
        if doc_id not in readable:
            try:
                await _load_document(db, doc_id, user)
                readable[doc_id] = True
            except HTTPException:
                readable[doc_id] = False
        if not readable[doc_id]:
            continue
        asset = await db.get(UserFile, asset_id)
        if (
            asset is None
            or asset.source_kind != GeneratedKind.DOCUMENT_ASSET.value
            or asset.source_file_id != doc_id
            or asset.trashed_at is not None
        ):
            continue
        out[url] = signed_url(doc_id, asset_id)
    return {"links": out}


# --------------------------------------------------------------------
# GET /api/documents/{document_id}/assets/{asset_id} — signed asset
# --------------------------------------------------------------------
@router.get("/{document_id}/assets/{asset_id}")
async def download_document_asset(
    document_id: uuid.UUID,
    asset_id: uuid.UUID,
    sig: str = Query(..., description="HMAC signature"),
    exp: int | None = Query(None, description="Expiry (unix seconds) of a short-lived link"),
    db: AsyncSession = Depends(get_db),
) -> FastAPIFileResponse:
    """Serve an inline document asset via its signed URL.

    Bypasses the normal bearer-token auth because ``<img>`` /
    ``<audio>`` element requests cannot attach custom headers. The
    signature binds the asset to its owning document — only someone
    who was handed the signed URL at upload time (because they had
    write access to the doc) or who later opened the doc (and got
    the URL as part of the rendered HTML / Y.Doc) can reach this.
    """
    from app.files.doc_assets import verify as _verify_asset_link

    if not _verify_asset_link(document_id, asset_id, sig, exp):
        # 404 rather than 403 so an attacker can't confirm the
        # asset exists by brute-forcing signatures.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )

    row = await db.get(UserFile, asset_id)
    if (
        row is None
        or row.source_kind != GeneratedKind.DOCUMENT_ASSET.value
        or row.source_file_id != document_id
        or row.trashed_at is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )

    from app.files.storage import absolute_path as _absolute_path

    abs_path = _absolute_path(row.storage_path)
    if not abs_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset data missing on disk"
        )

    # Canonical MIME for the extension beats the stored value so a
    # malformed row can never hand the browser ``text/html`` for a
    # ``.png`` asset.
    try:
        media_type = canonical_mime_for(row.filename)
    except KeyError:
        media_type = "application/octet-stream"

    # NOTE: ``inline`` disposition so the browser renders the
    # image/audio in place inside the document. The allowlist
    # already restricts this endpoint to ``image/*`` / ``audio/*``,
    # and the outer app's CSP keeps rendered HTML sanitised.
    return FastAPIFileResponse(
        path=str(abs_path),
        media_type=media_type,
        headers={
            "Content-Disposition": f'inline; filename="{row.filename}"',
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            # Signed URLs are stable per asset so we can cache
            # aggressively at the browser. 1 day keeps collab
            # sessions snappy without pinning a revoked asset
            # forever.
            "Cache-Control": "private, max-age=86400",
        },
    )


__all__ = ["router"]

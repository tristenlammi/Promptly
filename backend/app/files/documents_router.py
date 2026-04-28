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

import hashlib
import hmac
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import (
    APIRouter,
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
from sqlalchemy import and_
from sqlalchemy.ext.asyncio import AsyncSession

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
from app.files.models import DocumentState, FileFolder, UserFile
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
    FileResponse as FileResponseSchema,
    Scope,
)
from app.files.storage import (
    MAX_FILE_BYTES,
    absolute_path,
    copy_stream_to_disk,
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
def _mint_collab_token(*, document_id: uuid.UUID, user: User, perm: str) -> tuple[str, int]:
    now = int(time.time())
    exp = now + COLLAB_TOKEN_TTL_SECONDS
    payload: dict[str, Any] = {
        "sub": str(user.id),
        "type": "collab",
        "document_id": str(document_id),
        "perm": perm,
        "name": user.username,
        "color": _color_for_user(user.id),
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

def _asset_signature(*, asset_id: uuid.UUID, document_id: uuid.UUID) -> str:
    message = f"asset:{asset_id}:{document_id}".encode("utf-8")
    digest = hmac.new(
        settings.SECRET_KEY.encode("utf-8"), message, hashlib.sha256
    ).hexdigest()
    return digest


def _verify_asset_signature(
    *, asset_id: uuid.UUID, document_id: uuid.UUID, signature: str
) -> bool:
    expected = _asset_signature(asset_id=asset_id, document_id=document_id)
    return hmac.compare_digest(expected, signature)


def _signed_asset_url(*, asset_id: uuid.UUID, document_id: uuid.UUID) -> str:
    sig = _asset_signature(asset_id=asset_id, document_id=document_id)
    return f"/api/documents/{document_id}/assets/{asset_id}?sig={sig}"


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

    Grantees can read documents (handled via
    :func:`_load_document` walking grants) but cannot mutate
    them — collaborative editing of someone else's document
    intentionally requires them to "Copy to my files" first.
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
    from app.files.sharing import caller_grants_for_file

    grants = await caller_grants_for_file(db, row, user)
    if grants:
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

    # Seed the on-disk blob so preview + download work the moment
    # the user creates the document. Intentionally minimal — the
    # snapshot endpoint will overwrite it as soon as the first
    # edit flushes through Hocuspocus.
    new_id = uuid.uuid4()
    rel_path = storage_path_for(owner_id, new_id, ".html")
    ensure_bucket(owner_id)
    abs_path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write("")

    title = (body.name or _DEFAULT_DOCUMENT_TITLE).rstrip(".")
    filename = title if title.lower().endswith(".html") else f"{title}.html"
    filename = sanitize_filename(filename)

    row = UserFile(
        id=new_id,
        user_id=owner_id,
        folder_id=parent_folder.id if parent_folder else None,
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
    # loads the UserFile), so SQLAlchemy's unit of work doesn't
    # know about the FK dependency and could otherwise flush the
    # child first and trip ``document_state_file_id_fkey``.
    try:
        await db.flush()
    except Exception:
        delete_blob(rel_path)
        raise

    # Empty Y.Doc state. The client will initialise its own Y.Doc
    # on first load; this row just lets the Hocuspocus Database
    # extension return something instead of None on the very first
    # fetch (avoids a spurious "new doc" path).
    state = DocumentState(
        file_id=new_id,
        yjs_update=b"",
        version=0,
    )
    db.add(state)

    try:
        await db.commit()
    except Exception:
        delete_blob(rel_path)
        raise
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
    perm = "write" if _can_write(row.user_id, user) else "read"
    token, exp = _mint_collab_token(document_id=row.id, user=user, perm=perm)
    return CollabTokenResponse(
        token=token,
        expires_at=exp,
        user=CollabTokenUser(
            id=user.id,
            name=user.username,
            color=_color_for_user(user.id),
        ),
    )


# --------------------------------------------------------------------
# POST /api/documents/{id}/snapshot — internal snapshot writer
# --------------------------------------------------------------------
def _verify_collab_internal_caller(authorization: str | None) -> None:
    """Shared-secret check for the Hocuspocus → backend snapshot call.

    The collab service sends ``Authorization: Bearer <SECRET_KEY>``.
    Any external caller would need the server's SECRET_KEY, which is
    only ever available to services inside the docker network.
    Returns nothing on success, raises 403 otherwise.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Snapshot endpoint requires an internal bearer token",
        )
    presented = authorization.split(" ", 1)[1].strip()
    if not _constant_time_equal(presented, settings.SECRET_KEY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid internal bearer token",
        )


def _constant_time_equal(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


@router.post(
    "/{document_id}/snapshot",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def write_snapshot(
    document_id: uuid.UUID,
    request: Request,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Persist a rendered HTML + FTS snapshot of the current Y.Doc.

    Called by the Hocuspocus collab service with the binary Y.Doc
    bytes in the request body. The request is authenticated by the
    shared ``SECRET_KEY`` and never reaches the open internet
    (nginx only exposes ``/api/collab/*`` as the upgrade WS path —
    this HTTP path stays reachable from inside the docker network).
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

    # Render HTML from the Y.Doc. Empty documents yield empty HTML
    # which is still valid — the preview pane just shows a blank
    # page until someone types.
    html_text = render_html_from_update(body)
    html_text = sanitize_document_html(html_text)
    plain_text = extract_text_from_html(html_text)

    # Overwrite the file blob on disk.
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
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
) -> DocumentAssetResponse:
    """Upload an inline image or audio clip for a document.

    Creates a hidden sibling ``UserFile`` row so the asset gets
    storage quota accounting + auth gating for free, then returns
    the ``/api/files/{id}/download`` URL the TipTap node will use
    as its ``src``.
    """
    document = await _load_document(db, document_id, user)
    if not _can_write(document.user_id, user):
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
    # owning user's quota.
    if document.user_id is not None:
        quota = await get_quota(db, user)
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
        size = copy_stream_to_disk(
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
        canonical_mime = sniff_and_validate(
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

    strip_image_metadata_in_place(abs_path, canonical_mime)
    try:
        size = abs_path.stat().st_size
    except OSError:
        pass

    row = UserFile(
        id=new_id,
        user_id=document.user_id,
        folder_id=document.folder_id,
        filename=clean_name,
        original_filename=clean_name,
        mime_type=canonical_mime,
        size_bytes=size,
        storage_path=rel_path,
        source_kind=GeneratedKind.DOCUMENT_ASSET.value,
        source_file_id=document.id,
    )
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
    url = _signed_asset_url(asset_id=row.id, document_id=document.id)

    return DocumentAssetResponse(
        id=row.id,
        filename=row.filename,
        mime_type=row.mime_type,
        size_bytes=row.size_bytes,
        url=url,
    )


# --------------------------------------------------------------------
# GET /api/documents/{document_id}/assets/{asset_id} — signed asset
# --------------------------------------------------------------------
@router.get("/{document_id}/assets/{asset_id}")
async def download_document_asset(
    document_id: uuid.UUID,
    asset_id: uuid.UUID,
    sig: str = Query(..., description="HMAC signature"),
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
    if not _verify_asset_signature(
        asset_id=asset_id, document_id=document_id, signature=sig
    ):
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

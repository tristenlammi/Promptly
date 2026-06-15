"""Workspace canvases API — collab tokens + text sync (Phase 2).

A workspace canvas is a tldraw board synced over the same
Yjs/Hocuspocus substrate as Drive documents. This router owns the
non-websocket side:

    GET  /api/canvas/{id}                 metadata (id, workspace, title)
    GET  /api/canvas/{id}/collab-token    mint the canvas collab JWT
    POST /api/canvas/{id}/text            push flattened shape text (RAG)

Creation goes through the navigator (``POST /workspaces/{wid}/items``
with ``kind='canvas'``) via :func:`create_canvas_with_item` below, so a
canvas always arrives as a tree node.

There is deliberately **no snapshot endpoint** (unlike documents): the
collab server persists the tldraw Y.Doc straight to ``workspace_canvas``
and skips the HTML-render callback for canvas rooms. Text for retrieval
comes from the client via ``/text`` because the backend can't cheaply
decode the tldraw Yjs schema.
"""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Response,
    status,
)
from jose import jwt
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import JWT_ALGORITHM
from app.chat.models import Workspace, WorkspaceCanvas, WorkspaceItem
from app.config import get_settings
from app.database import get_db
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.files.schemas import CollabTokenResponse, CollabTokenUser
from app.files.storage import (
    absolute_path,
    delete_blob,
    ensure_bucket,
    storage_path_for,
)
from app.files.system_folders import get_or_create_subfolder
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

router = APIRouter()
settings = get_settings()

# Match the document collab token lifetime so the frontend's refresh
# scheduling logic is identical for both editor types.
CANVAS_TOKEN_TTL_SECONDS = 5 * 60

_CANVAS_COLOR_PALETTE = [
    "#D97757", "#4F46E5", "#0EA5E9", "#10B981",
    "#F59E0B", "#EF4444", "#A855F7", "#14B8A6",
]


def _color_for_user(user_id: uuid.UUID) -> str:
    return _CANVAS_COLOR_PALETTE[user_id.int % len(_CANVAS_COLOR_PALETTE)]


def _mint_canvas_token(
    *, canvas_id: uuid.UUID, user: User, perm: str
) -> tuple[str, int]:
    now = int(time.time())
    exp = now + CANVAS_TOKEN_TTL_SECONDS
    payload = {
        "sub": str(user.id),
        "type": "canvas",
        "canvas_id": str(canvas_id),
        "perm": perm,
        "name": user.username,
        "color": _color_for_user(user.id),
        "iat": now,
        "exp": exp,
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token, exp


# ---------------------------------------------------------------------
# Creation helper — called from the items router (kind='canvas')
# ---------------------------------------------------------------------
async def create_canvas_with_item(
    db: AsyncSession,
    *,
    ws: Workspace,
    owner: User,
    title: str,
    parent_id: uuid.UUID | None,
    position: float,
    canvases_folder_id: uuid.UUID,
) -> WorkspaceItem:
    """Create a canvas + its backing text file + the navigator item row.

    Flushed (not committed) so the items router composes it into one
    transaction. The backing text file (in ``Canvases/``) starts empty;
    the client fills it via ``/text`` once shapes carry text.
    """
    # 1) Backing text file — a plain .md so it's text-extractable for RAG.
    file_id = uuid.uuid4()
    rel_path = storage_path_for(owner.id, file_id, ".md")
    ensure_bucket(owner.id)
    abs_path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write("")
    text_file = UserFile(
        id=file_id,
        user_id=owner.id,
        folder_id=canvases_folder_id,
        filename=f"{title}.md",
        original_filename=f"{title}.md",
        mime_type="text/markdown",
        size_bytes=0,
        storage_path=rel_path,
        source_kind=GeneratedKind.CANVAS_TEXT.value,
        content_text=None,
    )
    db.add(text_file)
    try:
        await db.flush()
    except Exception:
        delete_blob(rel_path)
        raise

    # 2) Canvas row (empty Y.Doc seed) referencing the backing file.
    canvas = WorkspaceCanvas(
        workspace_id=ws.id,
        title=title,
        yjs_update=b"",
        text_file_id=text_file.id,
    )
    db.add(canvas)
    await db.flush()

    # 3) Navigator item.
    item = WorkspaceItem(
        workspace_id=ws.id,
        parent_id=parent_id,
        kind="canvas",
        ref_id=canvas.id,
        title=title,
        position=position,
        indexing_status="queued",
    )
    db.add(item)
    await db.flush()
    return item


# ---------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------
async def _load_canvas_with_access(
    canvas_id: uuid.UUID, user: User, db: AsyncSession
) -> tuple[WorkspaceCanvas, str]:
    canvas = await db.get(WorkspaceCanvas, canvas_id)
    if canvas is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Canvas not found"
        )
    _ws, role = await get_accessible_workspace(canvas.workspace_id, user, db)
    return canvas, role


# ---------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------
class CanvasMeta(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str


@router.get("/{canvas_id}", response_model=CanvasMeta)
async def get_canvas(
    canvas_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CanvasMeta:
    canvas, _role = await _load_canvas_with_access(canvas_id, user, db)
    return CanvasMeta(
        id=canvas.id, workspace_id=canvas.workspace_id, title=canvas.title
    )


@router.get("/{canvas_id}/collab-token", response_model=CollabTokenResponse)
async def get_canvas_collab_token(
    canvas_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CollabTokenResponse:
    canvas, role = await _load_canvas_with_access(canvas_id, user, db)
    perm = "read" if role == "viewer" else "write"
    token, exp = _mint_canvas_token(canvas_id=canvas.id, user=user, perm=perm)
    return CollabTokenResponse(
        token=token,
        expires_at=exp,
        user=CollabTokenUser(
            id=user.id, name=user.username, color=_color_for_user(user.id)
        ),
    )


class CanvasTextUpdate(BaseModel):
    text: str


@router.post(
    "/{canvas_id}/text",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def update_canvas_text(
    canvas_id: uuid.UUID,
    payload: CanvasTextUpdate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Persist the client-flattened shape text and re-index the canvas so
    workspace chats stay grounded in what's on the board."""
    canvas, role = await _load_canvas_with_access(canvas_id, user, db)
    require_workspace_write(role)

    text = (payload.text or "").strip()
    canvas.content_text = text or None
    canvas.updated_at = datetime.now(timezone.utc)

    # Mirror onto the backing Drive text file so it feeds knowledge_chunks.
    if canvas.text_file_id is not None:
        tf = await db.get(UserFile, canvas.text_file_id)
        if tf is not None:
            abs_path = absolute_path(tf.storage_path)
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as fh:
                fh.write(text)
            try:
                tf.size_bytes = abs_path.stat().st_size
            except OSError:
                tf.size_bytes = len(text.encode("utf-8"))
            tf.content_text = text or None
            tf.updated_at = datetime.now(timezone.utc)

    await db.commit()

    # Re-index off the navigator item (it carries the index-status chips).
    from sqlalchemy import select

    item = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.ref_id == canvas.id,
                WorkspaceItem.kind == "canvas",
            )
        )
    ).scalars().first()
    if item is not None:
        from app.workspaces.knowledge import index_canvas_for_workspace

        background.add_task(
            index_canvas_for_workspace, canvas.workspace_id, item.id
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router", "create_canvas_with_item"]

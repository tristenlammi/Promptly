"""Workspace navigator tree — the left-rail item CRUD (Phase 1a).

The workspace's primary surface is a unified, nestable, reorderable
tree (``workspace_items``) mixing folders, notes, and — synthesised at
read time — chats. This router owns that tree:

    GET    /workspaces/{wid}/tree                  nested navigator tree
    POST   /workspaces/{wid}/items                 create a folder or note
    PATCH  /workspaces/{wid}/items/{item_id}       rename / set icon
    POST   /workspaces/{wid}/items/{item_id}/move  reparent + reorder
    DELETE /workspaces/{wid}/items/{item_id}       delete (folder = subtree)

Notes are ordinary Drive Documents (``source_kind='document'``) created
in the workspace's ``Notes`` folder and linked here by ``ref_id`` — so a
note inherits the whole TipTap / Yjs / Drive stack for free. Chats are
*not* stored as item rows in Phase 1: they're listed from the
conversations carrying this ``workspace_id``, so they always show up
with no sync bookkeeping (positioning them inside folders is a later
refinement).

Mounted under ``/api/workspaces`` from ``app.main`` alongside the main
workspaces router; the ``/tree`` and ``/items`` paths don't collide with
that router's surface.
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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import JWT_ALGORITHM
from app.config import get_settings
from app.files.schemas import CollabTokenResponse, CollabTokenUser
from app.chat.models import (
    Conversation,
    Spreadsheet,
    Workspace,
    WorkspaceCanvas,
    WorkspaceItem,
)
from app.database import get_db
from app.files.documents_router import create_blank_document
from app.files.models import UserFile
from app.files.safety import sanitize_filename
from app.files.system_folders import get_or_create_subfolder
from app.workspaces.canvas_router import (
    _color_for_user,
    create_canvas_with_item,
)
from app.workspaces.schemas import (
    SpreadsheetResponse,
    SpreadsheetSaveRequest,
    WorkspaceFileContext,
    WorkspaceItemCreate,
    WorkspaceItemMove,
    WorkspaceItemNode,
    WorkspaceItemResponse,
    WorkspaceItemUpdate,
    WorkspaceMemoryAppendRequest,
    WorkspaceMemoryResponse,
    WorkspaceMemorySaveRequest,
)
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

router = APIRouter()

_DEFAULT_NOTE_TITLE = "Untitled note"
_DEFAULT_FOLDER_TITLE = "New folder"
_DEFAULT_CANVAS_TITLE = "Untitled canvas"
_DEFAULT_BOARD_TITLE = "Board"
_DEFAULT_NOTEBOOK_TITLE = "Notebook"


def _strip_doc_ext(name: str) -> str:
    """A note's display title is its Drive filename minus the document
    extension. Used to compare a tree title against the backing file's
    name so we don't re-rename the file when they already match."""
    low = name.lower()
    for ext in (".html", ".htm", ".md"):
        if low.endswith(ext):
            return name[: -len(ext)]
    return name


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
async def _load_item(
    db: AsyncSession, workspace_id: uuid.UUID, item_id: uuid.UUID
) -> WorkspaceItem:
    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )
    return item


async def _next_position(
    db: AsyncSession, workspace_id: uuid.UUID, parent_id: uuid.UUID | None
) -> float:
    """Top-of-list slot among ``parent_id``'s children: min - 1, so a freshly
    created item appears at the top of the tree (the rail orders by
    ``position`` ascending). Pinned items surface in their own section
    regardless of position."""
    current_min = await db.scalar(
        select(func.min(WorkspaceItem.position)).where(
            WorkspaceItem.workspace_id == workspace_id,
            WorkspaceItem.parent_id == parent_id,
        )
    )
    return float(current_min or 0.0) - 1.0


async def _validate_parent(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    child_kind: str | None = None,
) -> None:
    """A parent (when given) must be a *folder* or a *notebook* (container)
    in this workspace. Folders organise the tree; a notebook holds pages
    (its child items render as tabs). A notebook can't hold folders or
    nested notebooks (v1: no recursion)."""
    if parent_id is None:
        return
    parent = await _load_item(db, workspace_id, parent_id)
    if parent.kind == "container":
        if child_kind == "container":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A notebook can't contain another notebook.",
            )
        if child_kind == "folder":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A notebook holds pages, not folders.",
            )
        return
    if parent.kind != "folder":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Items can only be nested inside folders or notebooks.",
        )


async def _resolve_subfolder_id(
    db: AsyncSession, ws: Workspace, owner: User, name: str
) -> uuid.UUID:
    """Drive folder id of a per-type bucket (``Notes`` / ``Canvases`` /
    ``Files``) under the workspace's ``root_folder_id``.

    Recreates the bucket if the user deleted it, and self-heals a missing
    ``root_folder_id`` by seeding the whole folder tree (defensive: every
    workspace gets one at create time)."""
    if ws.root_folder_id is None:
        # Should not happen post-create, but never 500 on a missing root.
        from app.files.system_folders import create_workspace_folder_tree

        ws_folder = await create_workspace_folder_tree(db, owner, ws.title)
        ws.root_folder_id = ws_folder.id
        await db.flush()
    sub = await get_or_create_subfolder(
        db, user_id=owner.id, parent_id=ws.root_folder_id, name=name
    )
    return sub.id


async def _collect_subtree(
    db: AsyncSession, workspace_id: uuid.UUID, item: WorkspaceItem
) -> list[WorkspaceItem]:
    """The item plus every descendant (BFS over ``parent_id``)."""
    all_items = list(
        (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.workspace_id == workspace_id
                )
            )
        ).scalars()
    )
    by_parent: dict[uuid.UUID | None, list[WorkspaceItem]] = {}
    for it in all_items:
        by_parent.setdefault(it.parent_id, []).append(it)
    out: list[WorkspaceItem] = []
    stack = [item]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(by_parent.get(cur.id, []))
    return out


def _serialize_tree(items: list[WorkspaceItem]) -> list[WorkspaceItemNode]:
    """Build the nested node list from a flat, position-ordered item list."""
    children: dict[uuid.UUID | None, list[WorkspaceItem]] = {}
    for it in items:
        children.setdefault(it.parent_id, []).append(it)

    def build(parent_id: uuid.UUID | None) -> list[WorkspaceItemNode]:
        nodes: list[WorkspaceItemNode] = []
        # Natural (position) order — pinning surfaces items in the rail's
        # dedicated Pinned section rather than reordering them in place.
        for it in children.get(parent_id, []):
            nodes.append(
                WorkspaceItemNode(
                    id=it.id,
                    kind=it.kind,
                    ref_id=it.ref_id,
                    title=it.title,
                    icon=it.icon,
                    position=it.position,
                    indexing_status=it.indexing_status,
                    context_enabled=it.context_enabled,
                    pinned=it.pinned,
                    children=build(it.id),
                )
            )
        return nodes

    return build(None)


# ---------------------------------------------------------------------
# Tree
# ---------------------------------------------------------------------
@router.get("/{workspace_id}/tree", response_model=list[WorkspaceItemNode])
async def get_workspace_tree(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceItemNode]:
    """Return the workspace's navigator tree.

    Stored ``workspace_items`` (folders + notes, nested) come first,
    then the workspace's chats synthesised at root level (most-recent
    first). One flat HTTP shape the frontend renders as a single tree.
    """
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    items = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.archived_at.is_(None),
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars()
    )
    tree = _serialize_tree(items)

    # Synthesise chat nodes from the workspace's conversations. Top-level
    # chats carry no item row — the frontend opens them by ref_id. Chats that
    # are *notebook pages* DO have a backing ``kind='chat'`` item (rendered as
    # a tab inside their container), so exclude those here to avoid listing
    # them twice.
    page_chat_ids = set(
        (
            await db.execute(
                select(WorkspaceItem.ref_id).where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind == "chat",
                    WorkspaceItem.ref_id.is_not(None),
                )
            )
        ).scalars()
    )
    convs = [
        c
        for c in (
            await db.execute(
                select(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.archived_at.is_(None),
                )
                .order_by(Conversation.updated_at.desc())
            )
        ).scalars()
        if c.id not in page_chat_ids
    ]
    for idx, c in enumerate(convs):
        tree.append(
            WorkspaceItemNode(
                id=c.id,
                kind="chat",
                ref_id=c.id,
                title=c.title or "New chat",
                icon=None,
                # Sort chats after stored items; recency order within.
                position=1_000_000.0 + idx,
                # Chats are out of context by default; surface the toggle
                # state + index chip so the rail can show both.
                context_enabled=c.context_enabled,
                indexing_status=c.context_index_status,
                pinned=bool(c.pinned),
                children=[],
            )
        )

    # Synthesise automation (scheduled task) nodes the same way — the
    # caller's tasks homed in this workspace. Opened by ref_id at /tasks/{id}.
    from app.tasks.models import Task

    tasks = (
        await db.execute(
            select(Task)
            .where(Task.workspace_id == ws.id, Task.user_id == user.id)
            .order_by(Task.created_at.desc())
        )
    ).scalars()
    for idx, t in enumerate(tasks):
        tree.append(
            WorkspaceItemNode(
                id=t.id,
                kind="task",
                ref_id=t.id,
                title=t.title,
                icon=None,
                position=2_000_000.0 + idx,
                children=[],
            )
        )
    return tree


# ---------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------
@router.post(
    "/{workspace_id}/items",
    response_model=WorkspaceItemResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_workspace_item(
    workspace_id: uuid.UUID,
    payload: WorkspaceItemCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    """Create a folder, note, or canvas in the workspace tree.

    A note lays down a blank Drive Document in ``Notes/``; a canvas an
    Excalidraw board + backing text file in ``Canvases/``. The backing rows
    and the item row commit together so we never leave a dangling item
    or an orphan document/canvas."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    await _validate_parent(db, ws.id, payload.parent_id, payload.kind)

    position = await _next_position(db, ws.id, payload.parent_id)
    title = (payload.title or "").strip()

    if payload.kind in ("folder", "board", "container"):
        # All three are tree-only nodes with no backing Drive entity. A
        # board's tasks reference it via ``workspace_tasks.board_item_id``; a
        # container (notebook) holds its pages as child items. Deleting the
        # row cascades its children/tasks via the self/board FKs.
        default_title = {
            "folder": _DEFAULT_FOLDER_TITLE,
            "board": _DEFAULT_BOARD_TITLE,
            "container": _DEFAULT_NOTEBOOK_TITLE,
        }[payload.kind]
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind=payload.kind,
            ref_id=None,
            title=title or default_title,
            position=position,
        )
        db.add(item)
        await db.commit()
        await db.refresh(item)
        return WorkspaceItemResponse.model_validate(item)

    # Backing rows for notes / canvases live in the *owner's* Drive (the
    # Workspaces folder is the owner's); a single-user workspace means
    # owner == caller.
    owner = user if ws.user_id == user.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace owner is missing",
        )

    if payload.kind == "note":
        note_title = title or _DEFAULT_NOTE_TITLE
        notes_folder_id = await _resolve_subfolder_id(db, ws, owner, "Notes")
        doc = await create_blank_document(
            db, owner_id=owner.id, folder_id=notes_folder_id, name=note_title
        )
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind="note",
            ref_id=doc.id,
            title=note_title,
            position=position,
            indexing_status="queued",
        )
        db.add(item)
    elif payload.kind == "sheet":
        # A standalone spreadsheet — its backing entity is a ``Spreadsheet``
        # row (no Drive folder needed). RAG indexing of sheet content is a
        # later phase, so ``indexing_status`` stays NULL for now.
        sheet_title = title or _DEFAULT_SHEET_TITLE
        sheet = Spreadsheet(workspace_id=ws.id, title=sheet_title)
        db.add(sheet)
        await db.flush()  # assign sheet.id before the item links to it
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind="sheet",
            ref_id=sheet.id,
            title=sheet_title,
            position=position,
        )
        db.add(item)
    elif payload.kind == "chat":
        # A chat *page* inside a notebook. Unlike top-level chats (which are
        # synthesised at read time from conversations), a chat page is a real
        # child item whose backing entity is a Conversation. Only valid as a
        # notebook page — top-level chats use the normal chat-create path.
        if payload.parent_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Chats can only be created as a page inside a notebook.",
            )
        chat_title = title or "New chat"
        conv = Conversation(
            user_id=user.id,
            workspace_id=ws.id,
            title=chat_title,
            model_id=ws.default_model_id,
            provider_id=ws.default_provider_id,
        )
        db.add(conv)
        await db.flush()  # assign conv.id before the item links to it
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind="chat",
            ref_id=conv.id,
            title=chat_title,
            position=position,
        )
        db.add(item)
    else:  # kind == "canvas"
        canvas_title = title or _DEFAULT_CANVAS_TITLE
        canvases_folder_id = await _resolve_subfolder_id(
            db, ws, owner, "Canvases"
        )
        item = await create_canvas_with_item(
            db,
            ws=ws,
            owner=owner,
            title=canvas_title,
            parent_id=payload.parent_id,
            position=position,
            canvases_folder_id=canvases_folder_id,
        )

    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return WorkspaceItemResponse.model_validate(item)


_DEFAULT_SHEET_TITLE = "Untitled sheet"


# ---------------------------------------------------------------------
# Spreadsheet pages — single-user persistence
# ---------------------------------------------------------------------
async def _load_workspace_spreadsheet(
    db: AsyncSession, workspace_id: uuid.UUID, sheet_id: uuid.UUID
) -> Spreadsheet:
    sheet = await db.get(Spreadsheet, sheet_id)
    if sheet is None or sheet.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Spreadsheet not found",
        )
    return sheet


@router.get(
    "/{workspace_id}/spreadsheets/{sheet_id}",
    response_model=SpreadsheetResponse,
)
async def get_spreadsheet(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SpreadsheetResponse:
    """Load a spreadsheet page's workbook. Read access (any member)."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id)
    return SpreadsheetResponse.model_validate(sheet)


@router.put(
    "/{workspace_id}/spreadsheets/{sheet_id}",
    response_model=SpreadsheetResponse,
)
async def save_spreadsheet(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    payload: SpreadsheetSaveRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SpreadsheetResponse:
    """Persist a spreadsheet page's workbook (debounced save from the
    editor). Single-user for now — live collaboration is a later phase.
    Re-indexes the sheet so its cell text feeds workspace RAG + memory."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id)
    sheet.data = payload.data
    text_changed = (
        payload.content_text is not None
        and payload.content_text != sheet.content_text
    )
    if payload.content_text is not None:
        sheet.content_text = payload.content_text
    # The sheet is backed by a ``kind='sheet'`` WorkspaceItem; we need its id
    # both to align an in-editor rename and to enqueue re-indexing.
    sheet_item = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.ref_id == sheet.id,
                WorkspaceItem.kind == "sheet",
            )
        )
    ).scalars().first()
    if payload.title is not None and payload.title.strip():
        new_title = payload.title.strip()
        sheet.title = new_title
        if sheet_item is not None:
            sheet_item.title = new_title
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(sheet)
    # Embed the fresh cell text off the request path (no-op without an
    # embedding provider; the content_text still feeds full-dump + memory).
    if text_changed and sheet_item is not None:
        from app.workspaces.knowledge import index_sheet_for_workspace

        background.add_task(index_sheet_for_workspace, ws.id, sheet_item.id)
    return SpreadsheetResponse.model_validate(sheet)


# Match the document/canvas collab token lifetime so the frontend's refresh
# scheduling is identical across all three editor types.
_SHEET_TOKEN_TTL_SECONDS = 5 * 60


def _mint_sheet_token(
    *, sheet_id: uuid.UUID, user: User, perm: str
) -> tuple[str, int]:
    """A short-lived HS256 JWT the collab server validates for ``sheet:<id>``
    rooms — mirrors the canvas token, with ``type='sheet'``/``sheet_id``."""
    settings = get_settings()
    now = int(time.time())
    exp = now + _SHEET_TOKEN_TTL_SECONDS
    payload = {
        "sub": str(user.id),
        "type": "sheet",
        "sheet_id": str(sheet_id),
        "perm": perm,
        "name": user.username,
        "color": _color_for_user(user.id),
        "iat": now,
        "exp": exp,
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token, exp


@router.get(
    "/{workspace_id}/spreadsheets/{sheet_id}/collab-token",
    response_model=CollabTokenResponse,
)
async def get_sheet_collab_token(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CollabTokenResponse:
    """Mint the collab JWT for a sheet's ``sheet:<id>`` Yjs room. Viewers get
    a read-only token; editors get write."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id)
    perm = "read" if access_role == "viewer" else "write"
    token, exp = _mint_sheet_token(sheet_id=sheet.id, user=user, perm=perm)
    return CollabTokenResponse(
        token=token,
        expires_at=exp,
        user=CollabTokenUser(
            id=user.id, name=user.username, color=_color_for_user(user.id)
        ),
    )


# ---------------------------------------------------------------------
# Workspace map — the deterministic catalog injected into chat context
# ---------------------------------------------------------------------
@router.get("/{workspace_id}/map")
async def get_workspace_map_endpoint(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """The workspace's structural map (Markdown) — the same catalog injected
    into every chat's context. Surfaced so the user can see what the AI sees."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    from app.workspaces.knowledge import build_workspace_map

    md = await build_workspace_map(db, ws.id)
    return {"markdown": md or ""}


# ---------------------------------------------------------------------
# Workspace memory — the librarian-maintained doc, viewable + editable
# ---------------------------------------------------------------------
@router.get("/{workspace_id}/memory", response_model=WorkspaceMemoryResponse)
async def get_workspace_memory_endpoint(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceMemoryResponse:
    """The workspace's rolling memory doc — what the librarian has distilled.
    Read access for anyone who can open the workspace; edits gated separately."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    from app.workspaces.knowledge import get_workspace_memory_doc

    uf = await get_workspace_memory_doc(db, ws.id)
    return WorkspaceMemoryResponse(
        exists=uf is not None,
        markdown=(uf.content_text or "") if uf is not None else "",
        updated_at=uf.updated_at if uf is not None else None,
        auto_memory_enabled=ws.auto_memory_enabled,
        memory_mode=ws.memory_mode,
    )


@router.put("/{workspace_id}/memory", response_model=WorkspaceMemoryResponse)
async def save_workspace_memory_endpoint(
    workspace_id: uuid.UUID,
    payload: WorkspaceMemorySaveRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceMemoryResponse:
    """Hand-edit the workspace memory. Replaces the stored Markdown in place
    and re-indexes it so the edit feeds retrieval. Requires write access."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    from app.workspaces.knowledge import (
        get_workspace_memory_doc,
        index_file_for_workspace,
        save_workspace_memory,
    )

    file_id = await save_workspace_memory(db, ws=ws, content_md=payload.markdown)
    if file_id is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Couldn't save workspace memory.",
        )
    # Re-embed off the request path so the editor returns immediately.
    background.add_task(index_file_for_workspace, ws.id, file_id, force=True)

    uf = await get_workspace_memory_doc(db, ws.id)
    return WorkspaceMemoryResponse(
        exists=uf is not None,
        markdown=(uf.content_text or "") if uf is not None else payload.markdown,
        updated_at=uf.updated_at if uf is not None else None,
        auto_memory_enabled=ws.auto_memory_enabled,
        memory_mode=ws.memory_mode,
    )


@router.post(
    "/{workspace_id}/memory/regenerate", response_model=WorkspaceMemoryResponse
)
async def regenerate_workspace_memory_endpoint(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceMemoryResponse:
    """Manually rebuild the workspace memory from recent chats now — bypasses
    the auto-memory opt-in and the per-workspace cooldown. Requires write
    access. Runs the distillation inline so the fresh memory comes back in the
    response."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    from app.workspaces.knowledge import (
        get_workspace_memory_doc,
        index_file_for_workspace,
        mark_memory_refreshed,
        regenerate_workspace_memory,
    )

    file_id, _count = await regenerate_workspace_memory(db, ws=ws)
    if file_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Couldn't regenerate memory. Make sure a memory or default "
                "model is set and the workspace has at least one chat with a "
                "few messages."
            ),
        )
    mark_memory_refreshed(ws.id)
    await index_file_for_workspace(ws.id, file_id, force=True)

    uf = await get_workspace_memory_doc(db, ws.id)
    return WorkspaceMemoryResponse(
        exists=uf is not None,
        markdown=(uf.content_text or "") if uf is not None else "",
        updated_at=uf.updated_at if uf is not None else None,
        auto_memory_enabled=ws.auto_memory_enabled,
        memory_mode=ws.memory_mode,
    )


@router.post(
    "/{workspace_id}/memory/append", response_model=WorkspaceMemoryResponse
)
async def append_workspace_memory_endpoint(
    workspace_id: uuid.UUID,
    payload: WorkspaceMemoryAppendRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceMemoryResponse:
    """"Save to workspace memory" — hand a user-flagged snippet to the memory
    model, which decides how and where to fold it into the memory document
    (falling back to a verbatim pinned append if no model is available).
    Requires write access; re-indexes off the request path."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    from app.workspaces.knowledge import (
        get_workspace_memory_doc,
        index_file_for_workspace,
        integrate_into_workspace_memory,
    )

    file_id = await integrate_into_workspace_memory(db, ws=ws, text=payload.text)
    if file_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Nothing to save to memory.",
        )
    background.add_task(index_file_for_workspace, ws.id, file_id, force=True)

    uf = await get_workspace_memory_doc(db, ws.id)
    return WorkspaceMemoryResponse(
        exists=uf is not None,
        markdown=(uf.content_text or "") if uf is not None else "",
        updated_at=uf.updated_at if uf is not None else None,
        auto_memory_enabled=ws.auto_memory_enabled,
        memory_mode=ws.memory_mode,
    )


# ---------------------------------------------------------------------
# Read one item (e.g. a board's config / label registry)
# ---------------------------------------------------------------------
@router.get(
    "/{workspace_id}/items/{item_id}",
    response_model=WorkspaceItemResponse,
)
async def get_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    item = await _load_item(db, ws.id, item_id)
    return WorkspaceItemResponse.model_validate(item)


# ---------------------------------------------------------------------
# Rename / icon
# ---------------------------------------------------------------------
@router.patch(
    "/{workspace_id}/items/{item_id}",
    response_model=WorkspaceItemResponse,
)
async def update_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: WorkspaceItemUpdate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id)

    sent = payload.model_fields_set
    if "title" in sent:
        new_title = (payload.title or "").strip()
        if not new_title:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Title cannot be empty",
            )
        item.title = new_title
        # Keep the backing note's Drive filename in sync so the file is
        # recognisable in Drive / search — but only when it actually
        # differs. When the rename originated from the document editor the
        # file is already named ``new_title``, so re-renaming would just
        # ping-pong the extension. Best-effort: a missing/trashed file
        # just leaves the item renamed.
        if item.kind == "note" and item.ref_id is not None:
            uf = await db.get(UserFile, item.ref_id)
            if uf is not None and _strip_doc_ext(uf.filename) != new_title:
                uf.filename = sanitize_filename(f"{new_title}.html")
                uf.updated_at = datetime.now(timezone.utc)
    if "icon" in sent:
        item.icon = payload.icon
    if "context_enabled" in sent and payload.context_enabled is not None:
        # Note/canvas/board items participate in RAG context; folders/chats
        # carry the flag harmlessly but it's never consulted for them.
        item.context_enabled = payload.context_enabled
    if "pinned" in sent and payload.pinned is not None:
        item.pinned = payload.pinned
    if "config" in sent:
        # Kind-specific config (boards: label registry / columns).
        item.config = payload.config

    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)

    # Keep a board's RAG text current after a rename, and (re)index it when
    # the user turns its context toggle on — boards index lazily, so an
    # existing board first gets embedded the next time its tasks change or
    # it's enabled here.
    if item.kind == "board" and (
        "title" in sent or "context_enabled" in sent or "config" in sent
    ):
        from app.workspaces.knowledge import index_board_for_workspace

        background.add_task(index_board_for_workspace, ws.id, item.id)

    return WorkspaceItemResponse.model_validate(item)


# ---------------------------------------------------------------------
# Chat → workspace context (opt-in)
# ---------------------------------------------------------------------
@router.patch(
    "/{workspace_id}/chats/{conversation_id}/context",
    response_model=WorkspaceItemNode,
)
async def set_chat_context(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    payload: WorkspaceFileContext,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemNode:
    """Opt a workspace chat into (or out of) the RAG context.

    Chats are out of context by default. Turning this ON flattens the
    transcript into a backing Drive file and embeds it into the workspace
    pool (so other chats can retrieve it); turning it OFF drops the chunks
    and trashes the backing file. The actual (re-)index runs in the
    background — the chat's tree chip reflects ``context_index_status``.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.workspace_id != ws.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat not found in this workspace",
        )

    conv.context_enabled = payload.enabled
    conv.context_index_status = "queued" if payload.enabled else None
    conv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(conv)

    from app.workspaces.knowledge import (  # local — avoids import cycle
        index_chat_for_workspace,
        remove_chat_context,
    )

    if payload.enabled:
        background.add_task(index_chat_for_workspace, ws.id, conv.id)
    else:
        background.add_task(remove_chat_context, ws.id, conv.id)

    return WorkspaceItemNode(
        id=conv.id,
        kind="chat",
        ref_id=conv.id,
        title=conv.title or "New chat",
        icon=None,
        position=0.0,
        indexing_status=conv.context_index_status,
        context_enabled=conv.context_enabled,
        pinned=bool(conv.pinned),
        children=[],
    )


# ---------------------------------------------------------------------
# Move (reparent + reorder)
# ---------------------------------------------------------------------
@router.post(
    "/{workspace_id}/items/{item_id}/move",
    response_model=WorkspaceItemResponse,
)
async def move_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: WorkspaceItemMove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    """Reparent and/or reorder a tree item.

    Guards against the obvious cycle (an item can't become its own
    parent); a deeper descendant-cycle is impossible here because only
    folders can be parents and the frontend never offers a folder its
    own subtree as a drop target."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id)

    if payload.parent_id == item.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An item can't be moved inside itself.",
        )
    await _validate_parent(db, ws.id, payload.parent_id)

    item.parent_id = payload.parent_id
    item.position = payload.position
    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return WorkspaceItemResponse.model_validate(item)


# ---------------------------------------------------------------------
# Archive / unarchive (folder = its whole subtree)
# ---------------------------------------------------------------------
@router.post(
    "/{workspace_id}/items/{item_id}/archive",
    response_model=WorkspaceItemResponse,
)
async def archive_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    """Soft-archive an item (and, for a folder, its whole subtree) — it
    drops out of the tree into the workspace's Archive section."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id)
    now = datetime.now(timezone.utc)
    for it in await _collect_subtree(db, ws.id, item):
        it.archived_at = now
    ws.updated_at = now
    await db.commit()
    await db.refresh(item)
    return WorkspaceItemResponse.model_validate(item)


@router.post(
    "/{workspace_id}/items/{item_id}/unarchive",
    response_model=WorkspaceItemResponse,
)
async def unarchive_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    """Restore an archived item (+ its subtree) back into the tree."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id)
    now = datetime.now(timezone.utc)
    for it in await _collect_subtree(db, ws.id, item):
        it.archived_at = None
    ws.updated_at = now
    await db.commit()
    await db.refresh(item)
    return WorkspaceItemResponse.model_validate(item)


@router.get(
    "/{workspace_id}/archived-items",
    response_model=list[WorkspaceItemNode],
)
async def get_workspace_archive(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceItemNode]:
    """The workspace's Archive: archived item *roots* (the top of each
    archived subtree, so a folder shows one entry) plus archived
    workspace chats, most-recently-archived first."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    archived = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.archived_at.is_not(None),
                )
                .order_by(WorkspaceItem.archived_at.desc())
            )
        ).scalars()
    )
    archived_ids = {it.id for it in archived}
    nodes: list[WorkspaceItemNode] = [
        WorkspaceItemNode(
            id=it.id,
            kind=it.kind,
            ref_id=it.ref_id,
            title=it.title,
            icon=it.icon,
            position=it.position,
            indexing_status=it.indexing_status,
            children=[],
        )
        for it in archived
        # Only the root of each archived subtree (its parent isn't archived).
        if it.parent_id is None or it.parent_id not in archived_ids
    ]

    convs = list(
        (
            await db.execute(
                select(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.archived_at.is_not(None),
                )
                .order_by(Conversation.archived_at.desc())
            )
        ).scalars()
    )
    for c in convs:
        nodes.append(
            WorkspaceItemNode(
                id=c.id,
                kind="chat",
                ref_id=c.id,
                title=c.title or "New chat",
                icon=None,
                position=0,
                indexing_status=None,
                children=[],
            )
        )
    return nodes


# ---------------------------------------------------------------------
# Backlinks (Phase 4) — which notes [[wiki-link]] to this item
# ---------------------------------------------------------------------
@router.get(
    "/{workspace_id}/items/{item_id}/backlinks",
    response_model=list[WorkspaceItemNode],
)
async def get_item_backlinks(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceItemNode]:
    """Notes whose content wiki-links to this item.

    Wiki-links are rendered as in-app relative hrefs carrying
    ``item=<itemId>`` (``/workspaces/<wid>?item=<itemId>``), which survive
    the Yjs → HTML → sanitiser round-trip. We scan each live note's HTML
    blob for that token — cheap and robust, no link table to keep in sync.
    """
    from app.files.storage import absolute_path

    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    needle = f"item={item_id}"

    notes = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind == "note",
                    WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.id != item_id,
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars()
    )
    out: list[WorkspaceItemNode] = []
    for note in notes:
        if note.ref_id is None:
            continue
        uf = await db.get(UserFile, note.ref_id)
        if uf is None:
            continue
        try:
            html = absolute_path(uf.storage_path).read_text(encoding="utf-8")
        except OSError:
            continue
        if needle in html:
            out.append(
                WorkspaceItemNode(
                    id=note.id,
                    kind="note",
                    ref_id=note.ref_id,
                    title=note.title,
                    icon=note.icon,
                    position=note.position,
                    indexing_status=note.indexing_status,
                    children=[],
                )
            )
    return out


# ---------------------------------------------------------------------
# Delete (folder = its whole subtree)
# ---------------------------------------------------------------------
@router.delete(
    "/{workspace_id}/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete an item. Deleting a folder removes its whole subtree (the
    ``parent_id`` FK cascades the rows); every ``note`` in that subtree
    has its backing Drive Document moved to Trash first so the blob
    isn't orphaned but is still recoverable from the Files page."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id)

    # Collect the item + every descendant so we can trash their note
    # blobs before the cascade drops the rows.
    all_items = list(
        (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.workspace_id == ws.id
                )
            )
        ).scalars()
    )
    by_parent: dict[uuid.UUID | None, list[WorkspaceItem]] = {}
    for it in all_items:
        by_parent.setdefault(it.parent_id, []).append(it)

    doomed: list[WorkspaceItem] = []
    stack = [item]
    while stack:
        cur = stack.pop()
        doomed.append(cur)
        stack.extend(by_parent.get(cur.id, []))

    now = datetime.now(timezone.utc)
    # Backing-file ids whose RAG chunks must be purged. Trashing the file
    # alone does NOT drop its chunks (they key off the file id, not a FK
    # cascade), and retrieval would otherwise keep surfacing a deleted
    # board/note/sheet/canvas's stale content forever.
    chunk_file_ids: set[uuid.UUID] = set()
    for it in doomed:
        if it.kind in ("note", "board") and it.ref_id is not None:
            # Notes + boards back their content on a ref_id UserFile; trash
            # it. A board's tasks cascade via the board_item_id FK when the
            # item row is deleted.
            uf = await db.get(UserFile, it.ref_id)
            if uf is not None and uf.trashed_at is None:
                uf.trashed_at = now
            chunk_file_ids.add(it.ref_id)
        elif it.kind == "sheet" and it.ref_id is not None:
            # Drop the backing Spreadsheet row and trash its RAG text file
            # (neither is a tree-cascade target since ref_id isn't a real FK).
            sheet = await db.get(Spreadsheet, it.ref_id)
            if sheet is not None:
                if sheet.text_file_id is not None:
                    sf = await db.get(UserFile, sheet.text_file_id)
                    if sf is not None and sf.trashed_at is None:
                        sf.trashed_at = now
                    chunk_file_ids.add(sheet.text_file_id)
                await db.delete(sheet)
        elif it.kind == "chat" and it.ref_id is not None:
            # A chat page — delete the backing conversation (and its messages,
            # which cascade off the conversation FK).
            conv = await db.get(Conversation, it.ref_id)
            if conv is not None:
                if conv.context_file_id is not None:
                    chunk_file_ids.add(conv.context_file_id)
                await db.delete(conv)
        elif it.kind == "canvas" and it.ref_id is not None:
            # Trash the backing text file and drop the canvas row (the
            # canvas isn't a tree-cascade target since ref_id isn't a real FK).
            canvas = await db.get(WorkspaceCanvas, it.ref_id)
            if canvas is not None:
                if canvas.text_file_id is not None:
                    tf = await db.get(UserFile, canvas.text_file_id)
                    if tf is not None and tf.trashed_at is None:
                        tf.trashed_at = now
                    chunk_file_ids.add(canvas.text_file_id)
                await db.delete(canvas)

    # Purge the RAG chunks for every backing file we just retired so a
    # deleted item stops contributing to retrieval (and to the indexed-token
    # total that flips the workspace into retrieval mode).
    if chunk_file_ids:
        from app.custom_models.ingestion import delete_existing_chunks

        for fid in chunk_file_ids:
            await delete_existing_chunks(
                db, scope_kind="workspace", scope_id=ws.id, user_file_id=fid
            )

    # Deleting the top row cascades the descendant item rows via the
    # self-FK ON DELETE CASCADE.
    await db.delete(item)
    ws.updated_at = now
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]

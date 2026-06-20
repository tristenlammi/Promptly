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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import (
    Conversation,
    DocumentPage,
    Workspace,
    WorkspaceCanvas,
    WorkspaceItem,
)
from app.database import get_db
from app.files.documents_router import create_blank_document
from app.files.models import UserFile
from app.files.safety import sanitize_filename
from app.files.system_folders import get_or_create_subfolder
from app.workspaces.canvas_router import create_canvas_with_item
from app.workspaces.schemas import (
    DocumentPageCreate,
    DocumentPageResponse,
    DocumentPageUpdate,
    WorkspaceFileContext,
    WorkspaceItemCreate,
    WorkspaceItemMove,
    WorkspaceItemNode,
    WorkspaceItemResponse,
    WorkspaceItemUpdate,
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
    db: AsyncSession, workspace_id: uuid.UUID, parent_id: uuid.UUID | None
) -> None:
    """A parent (when given) must be a *folder* item in this workspace —
    you can't nest a note inside another note."""
    if parent_id is None:
        return
    parent = await _load_item(db, workspace_id, parent_id)
    if parent.kind != "folder":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Items can only be nested inside folders.",
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

    # Synthesise chat nodes from the workspace's conversations. They
    # carry no item row (Phase 1) — the frontend opens them by ref_id.
    # Archived chats drop to the workspace's Archive section.
    convs = list(
        (
            await db.execute(
                select(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.archived_at.is_(None),
                )
                .order_by(Conversation.updated_at.desc())
            )
        ).scalars()
    )
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
    await _validate_parent(db, ws.id, payload.parent_id)

    position = await _next_position(db, ws.id, payload.parent_id)
    title = (payload.title or "").strip()

    if payload.kind in ("folder", "board"):
        # Both are tree-only nodes with no backing Drive entity. A board's
        # tasks reference it via ``workspace_tasks.board_item_id``; deleting
        # the item cascades them.
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind=payload.kind,
            ref_id=None,
            title=title
            or (
                _DEFAULT_FOLDER_TITLE
                if payload.kind == "folder"
                else _DEFAULT_BOARD_TITLE
            ),
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
        # A note is a multi-page document: seed its first ("primary") page,
        # pointing at the same backing doc ``ref_id`` references. Flush first
        # so ``item.id`` is assigned before the page row links to it.
        await db.flush()
        db.add(
            DocumentPage(
                item_id=item.id,
                kind="richtext",
                ref_id=doc.id,
                title=note_title,
                position=0.0,
            )
        )
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


# ---------------------------------------------------------------------
# Document pages — a note is a multi-page document
# ---------------------------------------------------------------------
# A note (``kind='note'``) is the container; its pages live in
# ``document_pages``, each backed by its own Drive Document (richtext) and,
# later, spreadsheet rooms. The note keeps ``ref_id`` pointing at the first
# page so every single-page-era path (collab/RAG/snapshot/delete) is unchanged.
_DEFAULT_PAGE_TITLE = "Untitled page"


async def _load_note_item(
    db: AsyncSession, workspace_id: uuid.UUID, item_id: uuid.UUID
) -> WorkspaceItem:
    item = await _load_item(db, workspace_id, item_id)
    if item.kind != "note":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only document (note) items have pages.",
        )
    return item


async def _pages_for(
    db: AsyncSession, item_id: uuid.UUID
) -> list[DocumentPage]:
    return list(
        (
            await db.execute(
                select(DocumentPage)
                .where(DocumentPage.item_id == item_id)
                .order_by(DocumentPage.position.asc())
            )
        ).scalars()
    )


@router.get(
    "/{workspace_id}/items/{item_id}/pages",
    response_model=list[DocumentPageResponse],
)
async def list_document_pages(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[DocumentPageResponse]:
    """Ordered pages of a document. Read access (any workspace member)."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    item = await _load_note_item(db, ws.id, item_id)
    rows = await _pages_for(db, item.id)
    return [DocumentPageResponse.model_validate(r) for r in rows]


@router.post(
    "/{workspace_id}/items/{item_id}/pages",
    response_model=DocumentPageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_document_page(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: DocumentPageCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocumentPageResponse:
    """Append a page to a document. Phase 1: richtext only — lays down a
    blank Drive Document in the workspace's ``Notes`` folder (same stack a
    single-page note uses) and links it as the new last page."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_note_item(db, ws.id, item_id)

    owner = user if ws.user_id == user.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace owner is missing",
        )

    title = (payload.title or "").strip() or _DEFAULT_PAGE_TITLE
    notes_folder_id = await _resolve_subfolder_id(db, ws, owner, "Notes")
    doc = await create_blank_document(
        db, owner_id=owner.id, folder_id=notes_folder_id, name=title
    )
    # Append to the end of the tab strip (pages read left-to-right).
    current_max = await db.scalar(
        select(func.max(DocumentPage.position)).where(
            DocumentPage.item_id == item.id
        )
    )
    position = float(current_max or 0.0) + 1.0
    page = DocumentPage(
        item_id=item.id,
        kind="richtext",
        ref_id=doc.id,
        title=title,
        position=position,
    )
    db.add(page)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(page)
    return DocumentPageResponse.model_validate(page)


@router.patch(
    "/{workspace_id}/items/{item_id}/pages/{page_id}",
    response_model=DocumentPageResponse,
)
async def update_document_page(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    page_id: uuid.UUID,
    payload: DocumentPageUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocumentPageResponse:
    """Rename and/or reorder a page. PATCH: only keys present are applied."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_note_item(db, ws.id, item_id)
    page = await db.get(DocumentPage, page_id)
    if page is None or page.item_id != item.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Page not found"
        )

    sent = payload.model_fields_set
    if "title" in sent and payload.title is not None:
        new_title = payload.title.strip() or _DEFAULT_PAGE_TITLE
        page.title = new_title
        # Keep the backing doc filename in sync (mirrors note rename) so
        # Drive + the tab agree.
        if page.kind == "richtext" and page.ref_id is not None:
            uf = await db.get(UserFile, page.ref_id)
            if uf is not None and _strip_doc_ext(uf.filename) != new_title:
                uf.filename = sanitize_filename(f"{new_title}.html")
        # If this is the note's primary page, keep the tree title aligned.
        if item.ref_id == page.ref_id and item.title != new_title:
            item.title = new_title
    if "position" in sent and payload.position is not None:
        page.position = payload.position

    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(page)
    return DocumentPageResponse.model_validate(page)


@router.delete(
    "/{workspace_id}/items/{item_id}/pages/{page_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_document_page(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    page_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete a page and trash its backing document. Refuses to remove the
    last page — a document always keeps at least one."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_note_item(db, ws.id, item_id)
    pages = await _pages_for(db, item.id)
    page = next((p for p in pages if p.id == page_id), None)
    if page is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Page not found"
        )
    if len(pages) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A document must keep at least one page.",
        )

    now = datetime.now(timezone.utc)
    # Trash the backing document (its knowledge_chunks cascade off the file
    # delete, same as a note delete).
    if page.kind == "richtext" and page.ref_id is not None:
        uf = await db.get(UserFile, page.ref_id)
        if uf is not None and uf.trashed_at is None:
            uf.trashed_at = now
    # If we removed the note's *primary* page (the one ``item.ref_id`` points
    # at), re-point the item at the new first page so the single-page code
    # paths (collab/RAG/snapshot/delete) keep resolving to a live document.
    remaining = [p for p in pages if p.id != page.id]
    if item.ref_id == page.ref_id and remaining:
        new_primary = remaining[0]
        item.ref_id = new_primary.ref_id
        item.title = new_primary.title

    await db.delete(page)
    ws.updated_at = now
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    for it in doomed:
        if it.kind in ("note", "board") and it.ref_id is not None:
            # Notes + boards back their content on a ref_id UserFile; trash
            # it (its chunks cascade off the file delete). A board's tasks
            # cascade via the board_item_id FK when the item row is deleted.
            uf = await db.get(UserFile, it.ref_id)
            if uf is not None and uf.trashed_at is None:
                uf.trashed_at = now
            # A note is a multi-page document — trash every page's backing
            # doc too. The ``document_pages`` rows themselves cascade off the
            # item delete (item_id FK), but their files aren't a FK target.
            if it.kind == "note":
                page_ref_ids = list(
                    (
                        await db.execute(
                            select(DocumentPage.ref_id).where(
                                DocumentPage.item_id == it.id,
                                DocumentPage.ref_id.is_not(None),
                            )
                        )
                    ).scalars()
                )
                for pid in page_ref_ids:
                    if pid == it.ref_id:
                        continue  # primary page already trashed above
                    pf = await db.get(UserFile, pid)
                    if pf is not None and pf.trashed_at is None:
                        pf.trashed_at = now
        elif it.kind == "canvas" and it.ref_id is not None:
            # Trash the backing text file and drop the canvas row (its
            # chunks cascade off the file delete; the canvas isn't a
            # tree-cascade target since ref_id isn't a real FK).
            canvas = await db.get(WorkspaceCanvas, it.ref_id)
            if canvas is not None:
                if canvas.text_file_id is not None:
                    tf = await db.get(UserFile, canvas.text_file_id)
                    if tf is not None and tf.trashed_at is None:
                        tf.trashed_at = now
                await db.delete(canvas)

    # Deleting the top row cascades the descendant item rows via the
    # self-FK ON DELETE CASCADE.
    await db.delete(item)
    ws.updated_at = now
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]

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

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.concurrency import run_in_threadpool
from jose import jwt
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import JWT_ALGORITHM
from app.config import get_settings
from app.files.generated_kinds import GeneratedKind
from app.files.office import add_with_shell
from app.files.schemas import CollabTokenResponse, CollabTokenUser
from app.chat.models import (
    Conversation,
    Roster,
    Spreadsheet,
    Workspace,
    WorkspaceCanvas,
    WorkspaceItem,
    WorkspaceTask,
)
from app.database import get_db
from app.files.documents_router import create_blank_document
from app.files.models import DocumentState, UserFile
from app.files.storage import absolute_path
from app.files.safety import sanitize_filename
from app.files.system_folders import get_or_create_subfolder
from app.workspaces.canvas_router import (
    _color_for_user,
    create_canvas_with_item,
)
from app.workspaces.schemas import (
    RosterResponse,
    RosterSaveRequest,
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
from app.workspaces.visibility import conversation_visible_to, item_visible_to
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_admin,
    require_workspace_write,
)


def _require_roster_admin(kind: str, access_role: str) -> None:
    """Rosters are an owner/admin surface, not everyday editor content —
    creating, editing, renaming or removing one requires admin. Call after
    the normal write check with the item's kind."""
    if kind == "roster":
        require_workspace_admin(access_role)

logger = logging.getLogger(__name__)

router = APIRouter()

_DEFAULT_NOTE_TITLE = "Untitled note"
_DEFAULT_FOLDER_TITLE = "New folder"
_DEFAULT_CANVAS_TITLE = "Untitled canvas"
_DEFAULT_BOARD_TITLE = "Board"
_DEFAULT_NOTEBOOK_TITLE = "Notebook"
_DEFAULT_ROSTER_TITLE = "Untitled roster"
_DEFAULT_DISCUSSION_TITLE = "Discussion"


# ``config`` keys only the server may set. ``text_file_id`` points a
# discussion at its transcript file in Drive; letting the client set it
# meant anyone could aim the indexer at another user's file and have it
# overwritten or trashed.
SERVER_MANAGED_CONFIG_KEYS: frozenset[str] = frozenset({"text_file_id"})


def _merge_client_config(
    current: dict[str, Any] | None, incoming: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Apply a client-sent ``config`` without letting it touch server keys.

    Client values replace the whole config as before (boards rely on
    that), except server-managed keys: those are dropped from the
    incoming dict and carried over from the current one.
    """
    if incoming is None:
        kept = {
            k: v for k, v in (current or {}).items() if k in SERVER_MANAGED_CONFIG_KEYS
        }
        return kept or None
    merged = {k: v for k, v in incoming.items() if k not in SERVER_MANAGED_CONFIG_KEYS}
    for key in SERVER_MANAGED_CONFIG_KEYS:
        if current and key in current:
            merged[key] = current[key]
    return merged


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
def require_item_visible(item: WorkspaceItem, user: User) -> None:
    """404 when ``item`` is someone else's private draft.

    404 (not 403) on purpose — a private item's existence shouldn't be
    probeable by other members. Shared with the sheet/canvas/comment
    routers so every fetch path enforces the same rule the tree does.
    """
    if item.visibility == "private" and item.created_by != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )


async def _load_item(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    user: User | None = None,
) -> WorkspaceItem:
    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )
    if user is not None:
        require_item_visible(item, user)
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


async def _dedupe_default_title(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    base: str,
) -> str:
    """"New folder" → "New folder 2" when a live sibling already holds the
    name. Only applied to *default* titles — an explicit user-chosen title is
    respected verbatim (duplicates there are the user's call)."""
    taken = set(
        (
            await db.execute(
                select(WorkspaceItem.title).where(
                    WorkspaceItem.workspace_id == workspace_id,
                    WorkspaceItem.parent_id == parent_id,
                    WorkspaceItem.archived_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    if base not in taken:
        return base
    n = 2
    while f"{base} {n}" in taken:
        n += 1
    return f"{base} {n}"


async def _validate_parent(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    child_kind: str | None = None,
) -> None:
    """A parent (when given) must be a *notebook* (container) in this
    workspace — a notebook holds pages (its child items render as tabs).
    Notebooks can't nest (no notebook-in-notebook). Folders were removed,
    so a notebook is the only thing that can hold children."""
    if parent_id is None:
        return
    parent = await _load_item(db, workspace_id, parent_id)
    if parent.kind != "container":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Items can only be nested inside a notebook.",
        )
    if child_kind == "container":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A notebook can't contain another notebook.",
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
                    visibility=it.visibility,
                    created_by=it.created_by,
                    is_template=bool((it.config or {}).get("template")),
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
                    WorkspaceItem.trashed_at.is_(None),
                    # Private drafts only show for their creator (0134).
                    or_(
                        WorkspaceItem.visibility != "private",
                        WorkspaceItem.created_by == user.id,
                    ),
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars()
    )
    tree = _serialize_tree(items)

    # Placement (0140): chats + automations are synthesised into the tree
    # with no backing item row, but they carry ``ws_parent_id`` /
    # ``ws_position`` so the user can drag them into folders and reorder
    # them. Build an id → node index over the serialised item tree so a
    # placed node can be inserted under its parent folder; ``None`` parent
    # (or a parent that no longer exists) lands at root.
    node_index: dict[uuid.UUID, WorkspaceItemNode] = {}

    def _index(nodes: list[WorkspaceItemNode]) -> None:
        for n in nodes:
            node_index[n.id] = n
            if n.children:
                _index(n.children)

    _index(tree)

    def _place(node: WorkspaceItemNode, parent_id: uuid.UUID | None) -> None:
        parent = node_index.get(parent_id) if parent_id else None
        (parent.children if parent is not None else tree).append(node)

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
        # Creator sees their own chats; everyone else only the shared ones.
        and (c.user_id == user.id or c.visibility == "workspace")
    ]
    for idx, c in enumerate(convs):
        _place(
            WorkspaceItemNode(
                id=c.id,
                kind="chat",
                ref_id=c.id,
                title=c.title or "New chat",
                icon=None,
                # Placed chats sort by their ws_position; unplaced ones sit
                # after stored items in recency order (the historical default).
                position=(
                    c.ws_position
                    if c.ws_position is not None
                    else 1_000_000.0 + idx
                ),
                # Chats are out of context by default; surface the toggle
                # state + index chip so the rail can show both.
                context_enabled=c.context_enabled,
                indexing_status=c.context_index_status,
                pinned=bool(c.pinned),
                # Lets the rail badge a creator's own private chats and hide
                # the toggle affordance from non-creators.
                visibility=c.visibility,
                created_by=str(c.user_id),
                children=[],
            ),
            c.ws_parent_id,
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
        _place(
            WorkspaceItemNode(
                id=t.id,
                kind="task",
                ref_id=t.id,
                title=t.title,
                icon=None,
                position=(
                    t.ws_position
                    if t.ws_position is not None
                    else 2_000_000.0 + idx
                ),
                children=[],
            ),
            t.ws_parent_id,
        )

    # A placed chat/task can now be interleaved with stored items under a
    # folder, so re-sort every level by position (items came pre-sorted;
    # inserting a synthesised node may have broken that order).
    def _sort(nodes: list[WorkspaceItemNode]) -> None:
        nodes.sort(key=lambda n: n.position)
        for n in nodes:
            if n.children:
                _sort(n.children)

    _sort(tree)
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
    _require_roster_admin(payload.kind, access_role)
    await _validate_parent(db, ws.id, payload.parent_id, payload.kind)

    position = await _next_position(db, ws.id, payload.parent_id)
    title = (payload.title or "").strip()

    if payload.kind in ("board", "container", "discussion"):
        # Tree-only nodes with no backing Drive entity. A board's tasks
        # reference it via ``workspace_tasks.board_item_id``; a container
        # (notebook) holds its pages as child items; a discussion's threads
        # reference it via ``discussion_threads.item_id``. Deleting the row
        # cascades its children/tasks/threads via those FKs.
        default_title = {
            "board": _DEFAULT_BOARD_TITLE,
            "container": _DEFAULT_NOTEBOOK_TITLE,
            "discussion": _DEFAULT_DISCUSSION_TITLE,
        }[payload.kind]
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind=payload.kind,
            ref_id=None,
            title=title
            or await _dedupe_default_title(
                db, ws.id, payload.parent_id, default_title
            ),
            position=position,
            # Discussions are OPT-IN for AI context. Team chatter must never
            # be embedded until a member explicitly turns "use as context"
            # on — unlike notes/canvases, which default to on.
            context_enabled=payload.kind != "discussion",
            # Boards, notebooks and discussions were created unattributed —
            # so nobody could ever make a board private, and the activity
            # feed showed no creator.
            created_by=user.id,
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
        note_title = title or await _dedupe_default_title(
            db, ws.id, payload.parent_id, _DEFAULT_NOTE_TITLE
        )
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
            # Born blank → terminal "empty", not "queued". This create path
            # schedules no indexer, so a note that's never typed into would
            # otherwise stay "queued" forever and misreport as "indexing".
            # The first save flips it to embedding → ready via the document
            # save hook (documents_router → index_note_for_workspace).
            indexing_status="empty",
        )
        db.add(item)
    elif payload.kind == "sheet":
        # A standalone spreadsheet — its backing entity is a ``Spreadsheet``
        # row (no Drive folder needed). RAG indexing of sheet content is a
        # later phase, so ``indexing_status`` stays NULL for now.
        sheet_title = title or await _dedupe_default_title(
            db, ws.id, payload.parent_id, _DEFAULT_SHEET_TITLE
        )
        sheet = Spreadsheet(workspace_id=ws.id, title=sheet_title)
        # With its Drive shell (WP-3.2); flushes, so sheet.id is assigned.
        await add_with_shell(db, sheet, kind=GeneratedKind.SHEET.value)
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind="sheet",
            ref_id=sheet.id,
            title=sheet_title,
            position=position,
        )
        db.add(item)
    elif payload.kind == "roster":
        # A shift roster — backing entity is a ``Roster`` row (mirrors sheet).
        # ``content_text`` feeds RAG once saved, so the item indexes like a
        # note/canvas; ``queued`` until the first save flattens the schedule.
        roster_title = title or await _dedupe_default_title(
            db, ws.id, payload.parent_id, _DEFAULT_ROSTER_TITLE
        )
        roster = Roster(workspace_id=ws.id, title=roster_title)
        db.add(roster)
        await db.flush()  # assign roster.id before the item links to it
        item = WorkspaceItem(
            workspace_id=ws.id,
            parent_id=payload.parent_id,
            kind="roster",
            ref_id=roster.id,
            title=roster_title,
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
        canvas_title = title or await _dedupe_default_title(
            db, ws.id, payload.parent_id, _DEFAULT_CANVAS_TITLE
        )
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

    item.created_by = user.id  # attribution + private-visibility (0134)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)

    # Automations (E-batch): item creation fires event-triggered flows.
    # Post-commit + fire-and-forget so a flow can never fail the create.
    from app.tasks.events import EVENT_ITEM_CREATED, emit_workspace_event

    emit_workspace_event(
        workspace_id=ws.id,
        event=EVENT_ITEM_CREATED,
        payload={
            "item_id": str(item.id),
            "kind": item.kind,
            "title": item.title,
            "created_by": user.username,
        },
    )
    return WorkspaceItemResponse.model_validate(item)


COPYABLE_KINDS = ("note", "sheet", "board", "canvas", "roster", "container")


async def reconcile_board_cards(db: AsyncSession, board: WorkspaceItem) -> int:
    """Bring cards in line with the board's columns after a config change
    (R-201): a column flagged (or un-flagged) Done updates its cards' done
    state, and cards whose column was deleted move to the first column
    instead of keeping a status nothing shows. Returns cards changed."""
    from app.workspaces.board_columns import board_columns, done_status_ids

    cols = [cid for cid, _ in board_columns(board.config)]
    done_ids = set(done_status_ids(board.config))
    now = datetime.now(timezone.utc)
    changed = 0
    for t in (
        await db.execute(select(WorkspaceTask).where(WorkspaceTask.board_item_id == board.id))
    ).scalars():
        status_ = t.status if t.status in cols else (cols[0] if cols else t.status)
        done = status_ in done_ids
        if status_ != t.status or done != bool(t.done):
            t.status = status_
            if done != bool(t.done):
                t.done = done
                t.completed_at = now if done else None
            changed += 1
    return changed


async def copy_item_into(
    db: AsyncSession,
    src: WorkspaceItem,
    *,
    dest_ws: Workspace,
    owner: User,
    creator_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    position: float,
    title: str,
) -> WorkspaceItem:
    """Deep-copy one item into ``dest_ws`` (the same workspace for
    "Duplicate", another for duplicating a whole workspace — R-204).
    Flushes, doesn't commit; the caller schedules re-indexing."""
    same_ws = dest_ws.id == src.workspace_id
    if src.kind == "note":
        src_file = await db.get(UserFile, src.ref_id) if src.ref_id else None
        if src_file is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="This note has no underlying document.",
            )
        folder_id = (
            src_file.folder_id
            if same_ws
            else await _resolve_subfolder_id(db, dest_ws, owner, "Notes")
        )
        doc = await create_blank_document(
            db, owner_id=owner.id, folder_id=folder_id, name=title
        )
        # Copy the rendered HTML blob so preview/download match immediately.
        try:
            blob = absolute_path(src_file.storage_path).read_bytes()
            absolute_path(doc.storage_path).write_bytes(blob)
            doc.size_bytes = len(blob)
        except OSError:
            pass  # blob copy is best-effort; the Yjs state is the truth
        doc.content_text = src_file.content_text
        # Copy the merged Y.Doc so the collab server serves the full
        # content for the copy (create_blank_document seeded an empty row).
        src_state = await db.get(DocumentState, src.ref_id)
        new_state = await db.get(DocumentState, doc.id)
        if src_state is not None and new_state is not None:
            new_state.yjs_update = src_state.yjs_update
            new_state.version = src_state.version
        # The copy gets its own pictures, re-pointed in its content (R-228).
        from app.files.doc_assets import relink_copy

        await relink_copy(db, src_file.id, doc)
        item = WorkspaceItem(
            workspace_id=dest_ws.id,
            parent_id=parent_id,
            kind="note",
            ref_id=doc.id,
            title=title,
            position=position,
            indexing_status="queued",
            context_enabled=src.context_enabled,
        )
        db.add(item)
    elif src.kind == "sheet":
        src_sheet = (
            await db.get(Spreadsheet, src.ref_id) if src.ref_id else None
        )
        if src_sheet is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="This sheet has no underlying spreadsheet.",
            )
        sheet = Spreadsheet(
            workspace_id=dest_ws.id,
            title=title,
            data=src_sheet.data,
            yjs_update=src_sheet.yjs_update,
            version=src_sheet.version,
            content_text=src_sheet.content_text,
        )
        await add_with_shell(db, sheet, kind=GeneratedKind.SHEET.value)
        item = WorkspaceItem(
            workspace_id=dest_ws.id,
            parent_id=parent_id,
            kind="sheet",
            ref_id=sheet.id,
            title=title,
            position=position,
            context_enabled=src.context_enabled,
        )
        db.add(item)
    elif src.kind == "canvas":
        src_canvas = (
            await db.get(WorkspaceCanvas, src.ref_id) if src.ref_id else None
        )
        if src_canvas is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="This canvas has no underlying scene.",
            )
        canvases_folder_id = await _resolve_subfolder_id(
            db, dest_ws, owner, "Canvases"
        )
        item = await create_canvas_with_item(
            db,
            ws=dest_ws,
            owner=owner,
            title=title,
            parent_id=parent_id,
            position=position,
            canvases_folder_id=canvases_folder_id,
        )
        item.context_enabled = src.context_enabled
        # The scene is the Y.Doc bytes — images ride along inside its
        # ``files`` map, so a byte copy is complete.
        copy_canvas = await db.get(WorkspaceCanvas, item.ref_id)
        if copy_canvas is not None:
            copy_canvas.yjs_update = src_canvas.yjs_update
            copy_canvas.version = src_canvas.version
            copy_canvas.content_text = src_canvas.content_text
            # Mirror the flattened text onto the new backing file (same
            # as POST /canvas/{id}/text) so retrieval picks the copy up
            # without waiting for a client push.
            if copy_canvas.text_file_id is not None and src_canvas.content_text:
                tf = await db.get(UserFile, copy_canvas.text_file_id)
                if tf is not None:
                    text = src_canvas.content_text
                    abs_path = absolute_path(tf.storage_path)
                    abs_path.parent.mkdir(parents=True, exist_ok=True)
                    with open(abs_path, "w", encoding="utf-8") as fh:
                        fh.write(text)
                    tf.size_bytes = len(text.encode("utf-8"))
                    tf.content_text = text
    elif src.kind == "roster":
        src_roster = await db.get(Roster, src.ref_id) if src.ref_id else None
        roster = Roster(
            workspace_id=dest_ws.id,
            title=title,
            data=src_roster.data if src_roster else None,
            content_text=src_roster.content_text if src_roster else None,
        )
        db.add(roster)
        await db.flush()
        item = WorkspaceItem(
            workspace_id=dest_ws.id,
            parent_id=parent_id,
            kind="roster",
            ref_id=roster.id,
            title=title,
            position=position,
            context_enabled=src.context_enabled,
        )
        db.add(item)
    elif src.kind == "container":
        # The notebook itself — its pages are copied by the caller.
        item = WorkspaceItem(
            workspace_id=dest_ws.id,
            parent_id=None,
            kind="container",
            title=title,
            position=position,
            icon=src.icon,
            config=src.config,
            context_enabled=src.context_enabled,
        )
        db.add(item)
    else:  # board
        item = WorkspaceItem(
            workspace_id=dest_ws.id,
            parent_id=parent_id,
            kind="board",
            ref_id=None,
            title=title,
            position=position,
            config=src.config,
            context_enabled=src.context_enabled,
        )
        db.add(item)
        await db.flush()
        tasks = (
            (
                await db.execute(
                    select(WorkspaceTask).where(
                        WorkspaceTask.board_item_id == src.id
                    )
                )
            )
            .scalars()
            .all()
        )
        for t in tasks:
            db.add(
                WorkspaceTask(
                    workspace_id=dest_ws.id,
                    board_item_id=item.id,
                    title=t.title,
                    description=t.description,
                    subtasks=t.subtasks,
                    labels=t.labels,
                    links=t.links,
                    attachments=t.attachments,
                    # Another workspace's members aren't this one's.
                    assignee_user_id=t.assignee_user_id if same_ws else None,
                    done=t.done,
                    status=t.status,
                    priority=t.priority,
                    due_at=t.due_at,
                    position=t.position,
                    completed_at=t.completed_at,
                    fields=t.fields,  # custom-field values (R-201)
                    created_by=creator_id,
                )
            )

    item.created_by = creator_id  # whoever copied it owns the copy (0134)
    await db.flush()
    return item


@router.post(
    "/{workspace_id}/items/{item_id}/duplicate",
    response_model=WorkspaceItemResponse,
    status_code=status.HTTP_201_CREATED,
)
async def duplicate_workspace_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    """Deep-copy a note, sheet, or board as a sibling ("Research 2").

    * **note** — new Drive Document; copies the HTML blob *and* the Yjs
      state, so the copy opens with the full content (not a blank doc
      waiting for a client seed).
    * **sheet** — new ``Spreadsheet`` row; copies the workbook JSON, the
      Yjs state, and the flattened text.
    * **board** — new item with the same ``config`` (columns / labels)
      plus a copy of every card (comments are history, not content —
      they stay behind; attachment references are shared).
    * **canvas** — new ``WorkspaceCanvas`` + backing text file; the
      Excalidraw scene (including image binaries — they live *inside*
      the Y.Doc's ``files`` map, not as external assets) copies with the
      ``yjs_update`` bytes, so the duplicate is fully self-contained.

    Automations aren't duplicable here (they're tasks, not items) — use
    ``POST /tasks/{id}/duplicate``. 422 for anything else unsupported.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    src = await db.get(WorkspaceItem, item_id)
    if src is None or src.workspace_id != ws.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )
    require_item_visible(src, user)
    if src.kind not in ("note", "sheet", "board", "canvas"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Duplicating a {src.kind} isn't supported yet.",
        )

    owner = user if ws.user_id == user.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace owner is missing",
        )

    position = await _next_position(db, ws.id, src.parent_id)
    # The source title always collides with itself, so the dedupe helper
    # yields "Research 2" (or " 3", …) directly.
    title = await _dedupe_default_title(db, ws.id, src.parent_id, src.title)

    item = await copy_item_into(
        db,
        src,
        dest_ws=ws,
        owner=owner,
        creator_id=user.id,
        parent_id=src.parent_id,
        position=position,
        title=title,
    )
    item.created_by = user.id  # the duplicator owns the copy (0134)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)

    # Re-embed the copy so workspace chats can retrieve it (best-effort).
    from app.workspaces.knowledge import (
        index_board_for_workspace,
        index_canvas_for_workspace,
        index_note_for_workspace,
        index_sheet_for_workspace,
    )

    if src.kind == "note":
        background.add_task(index_note_for_workspace, ws.id, item.id)
    elif src.kind == "sheet":
        background.add_task(index_sheet_for_workspace, ws.id, item.id)
    elif src.kind == "canvas":
        background.add_task(index_canvas_for_workspace, ws.id, item.id)
    else:
        background.add_task(index_board_for_workspace, ws.id, item.id)

    return WorkspaceItemResponse.model_validate(item)


_DEFAULT_SHEET_TITLE = "Untitled sheet"

# A version at most this often while someone edits; always before an
# import, restore or clear (R-132).
# Workbook JSON a save may carry (WP-3.3) — generous for real sheets.
_MAX_WORKBOOK_JSON_BYTES = 20 * 1024 * 1024
_SHEET_VERSION_EVERY = timedelta(minutes=10)
_SHEET_VERSIONS_KEPT = 100


async def snapshot_spreadsheet(
    db: AsyncSession, sheet: Spreadsheet, user: User, *, reason: str
) -> bool:
    """Keep the workbook as it is *now* as a version (before it changes).
    Autosaves are throttled; other reasons always snapshot. Flushes."""
    from app.chat.models import SpreadsheetVersion
    from app.workspaces.sheet_io import cell_count

    n = cell_count(sheet.data)
    if n == 0:
        return False
    if reason == "autosave":
        last = await db.scalar(
            select(func.max(SpreadsheetVersion.created_at)).where(
                SpreadsheetVersion.spreadsheet_id == sheet.id
            )
        )
        if last is not None and datetime.now(timezone.utc) - last < _SHEET_VERSION_EVERY:
            return False
    db.add(
        SpreadsheetVersion(
            spreadsheet_id=sheet.id, data=sheet.data, cell_count=n, reason=reason, created_by=user.id
        )
    )
    await db.flush()
    stale = (
        await db.execute(
            select(SpreadsheetVersion.id)
            .where(SpreadsheetVersion.spreadsheet_id == sheet.id)
            .order_by(SpreadsheetVersion.created_at.desc())
            .offset(_SHEET_VERSIONS_KEPT)
        )
    ).scalars().all()
    if stale:
        from sqlalchemy import delete as _delete

        await db.execute(_delete(SpreadsheetVersion).where(SpreadsheetVersion.id.in_(stale)))
    if reason != "autosave":
        # Also a full editor-state snapshot (Yjs + workbook), recoverable
        # even after these workbook versions roll off (WP-3.3).
        from app.files.versions import snapshot_file

        shell = await db.get(UserFile, sheet.file_id)
        if shell is not None:
            await snapshot_file(
                db,
                shell,
                source={"import": "import", "restore": "restore"}.get(reason, "manual"),
                label="Before Clear sheet" if reason == "clear" else None,
                author_id=user.id,
            )
    return True


@router.get("/{workspace_id}/spreadsheets/{sheet_id}/export")
async def export_spreadsheet(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    format: str = "xlsx",
    tab: int = 0,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """The sheet as .xlsx (every tab, formulas kept) or .csv (one tab)."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    return await sheet_export_response(sheet, format, tab)


async def sheet_export_response(sheet: Spreadsheet, format: str, tab: int) -> Response:
    """The sheet as .xlsx (every tab, formulas kept) or .csv (one tab)."""
    from app.workspaces.sheet_io import to_csv, to_xlsx

    stem = sanitize_filename((sheet.title or "Sheet").strip() or "Sheet")[:80]
    if format == "csv":
        body = to_csv(sheet.data, tab).encode("utf-8-sig")
        media, ext = "text/csv; charset=utf-8", "csv"
    elif format == "xlsx":
        body = await run_in_threadpool(to_xlsx, sheet.data)
        media, ext = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="format must be xlsx or csv")
    return Response(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'},
    )


@router.post("/{workspace_id}/spreadsheets/{sheet_id}/import")
async def import_into_spreadsheet(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Convert an .xlsx or .csv into this sheet's format and return it; the
    editor loads it (so it reaches everyone in the room) and saves. The
    current contents are kept as a version first, so it can be undone."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    return await sheet_import_data(db, sheet, file, user)


async def sheet_import_data(db: AsyncSession, sheet: Spreadsheet, file: UploadFile, user: User) -> dict:
    """Convert an upload into the sheet's format (current contents become a
    version first). Shared with the file route. Commits."""
    from app.workspaces.sheet_io import SheetImportError, import_spreadsheet

    raw = await file.read(25 * 1024 * 1024 + 1)
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Files are capped at 25 MB.")
    try:
        data, notes = await run_in_threadpool(import_spreadsheet, raw, file.filename or "")
    except SheetImportError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    await snapshot_spreadsheet(db, sheet, user, reason="import")
    await db.commit()
    # ``notes``: what didn't come across (charts, comments, …) — WP-4.4.
    return {"data": data, "notes": notes}


class SheetVersionRow(BaseModel):
    id: uuid.UUID
    created_at: datetime
    cell_count: int
    reason: str
    author: str | None = None


@router.get(
    "/{workspace_id}/spreadsheets/{sheet_id}/versions",
    response_model=list[SheetVersionRow],
)
async def list_spreadsheet_versions(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SheetVersionRow]:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    return await sheet_version_rows(db, sheet)


async def sheet_version_rows(db: AsyncSession, sheet: Spreadsheet) -> list[SheetVersionRow]:
    from app.chat.models import SpreadsheetVersion

    rows = (
        await db.execute(
            select(SpreadsheetVersion, User.username)
            .outerjoin(User, User.id == SpreadsheetVersion.created_by)
            .where(SpreadsheetVersion.spreadsheet_id == sheet.id)
            .order_by(SpreadsheetVersion.created_at.desc())
            .limit(_SHEET_VERSIONS_KEPT)
        )
    ).all()
    return [
        SheetVersionRow(id=v.id, created_at=v.created_at, cell_count=v.cell_count, reason=v.reason, author=name)
        for v, name in rows
    ]


@router.get("/{workspace_id}/spreadsheets/{sheet_id}/versions/{version_id}")
async def get_spreadsheet_version(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """A version's workbook — the editor restores it through the room (and
    the current contents become a version first, via the import path's
    snapshot on the next save)."""
    from app.chat.models import SpreadsheetVersion

    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    v = await db.get(SpreadsheetVersion, version_id)
    if v is None or v.spreadsheet_id != sheet.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return {"data": v.data}


@router.post("/{workspace_id}/spreadsheets/{sheet_id}/versions/checkpoint")
async def checkpoint_spreadsheet(
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    reason: str = "restore",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Keep the current contents as a version right now — before a restore
    or a clear, so either can be undone."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    made = await snapshot_spreadsheet(
        db, sheet, user, reason=reason if reason in ("restore", "clear") else "restore"
    )
    await db.commit()
    return {"saved": made}


# ---------------------------------------------------------------------
# Spreadsheet pages — single-user persistence
# ---------------------------------------------------------------------
async def _load_workspace_spreadsheet(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    sheet_id: uuid.UUID,
    user: User | None = None,
) -> Spreadsheet:
    sheet = await db.get(Spreadsheet, sheet_id)
    if sheet is None or sheet.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Spreadsheet not found",
        )
    if user is not None:
        # Private drafts (0134): the visibility flag lives on the backing
        # navigator item — enforce it on direct fetches too, not just the
        # tree (the tree hiding a row is worthless if the API serves it).
        item = (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.ref_id == sheet.id,
                    WorkspaceItem.kind == "sheet",
                )
            )
        ).scalars().first()
        if item is not None:
            require_item_visible(item, user)
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
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    from app.files.office_router import _name_tabs

    await _name_tabs(db, sheet)
    return SpreadsheetResponse.model_validate(sheet)


async def apply_sheet_save(
    db: AsyncSession,
    sheet: Spreadsheet,
    payload: SpreadsheetSaveRequest,
    user: User,
    background: BackgroundTasks,
) -> Spreadsheet:
    """The workbook save, once access is checked — shared by the workspace
    route and the file route (``/api/files/{id}/sheet``, WP-3.4). Commits."""
    # Size cap: the workbook used to be accepted at any size.
    import json as _json

    if len(_json.dumps(payload.data, separators=(",", ":"))) > _MAX_WORKBOOK_JSON_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="This workbook is too large to save — split it into smaller sheets.",
        )
    # Conditional save (WP-3.3): based on an older version means someone
    # else saved in between — don't overwrite their tabs and structure.
    if payload.data_version is not None and payload.data_version != (sheet.data_version or 0):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "stale",
                "data_version": sheet.data_version or 0,
                "data": sheet.data,
            },
        )
    if payload.data != sheet.data:
        await snapshot_spreadsheet(db, sheet, user, reason="autosave")
        sheet.data_version = (sheet.data_version or 0) + 1
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
    if sheet.workspace_id is not None:
        ws = await db.get(Workspace, sheet.workspace_id)
        if ws is not None:
            ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(sheet)
    # Embed the fresh cell text off the request path (no-op without an
    # embedding provider; the content_text still feeds full-dump + memory).
    if text_changed and sheet_item is not None:
        from app.workspaces.knowledge import index_sheet_for_workspace

        background.add_task(index_sheet_for_workspace, sheet.workspace_id, sheet_item.id)
    return sheet


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
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    await apply_sheet_save(db, sheet, payload, user, background)
    return SpreadsheetResponse.model_validate(sheet)


# --------------------------------------------------------------------
# Rosters — the shift-schedule item (mirrors the spreadsheet endpoints).
# --------------------------------------------------------------------
async def _load_workspace_roster(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    roster_id: uuid.UUID,
    user: User | None = None,
) -> Roster:
    roster = await db.get(Roster, roster_id)
    if roster is None or roster.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Roster not found"
        )
    if user is not None:
        item = (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.ref_id == roster.id,
                    WorkspaceItem.kind == "roster",
                )
            )
        ).scalars().first()
        if item is not None:
            require_item_visible(item, user)
    return roster


@router.get(
    "/{workspace_id}/rosters/{roster_id}",
    response_model=RosterResponse,
)
async def get_roster(
    workspace_id: uuid.UUID,
    roster_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RosterResponse:
    """Load a roster's schedule. Read access (any member)."""
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    roster = await _load_workspace_roster(db, ws.id, roster_id, user)
    data = roster.data if isinstance(roster.data, dict) else None
    if role not in ("owner", "admin") and data and isinstance(data.get("published_shifts"), list):
        # Staff see what was published, not the manager's work in progress
        # (R-174 — Publish used to change nothing anyone else saw).
        out = RosterResponse.model_validate(roster)
        out.data = {**data, "shifts": data["published_shifts"]}
        return out
    return RosterResponse.model_validate(roster)


@router.put(
    "/{workspace_id}/rosters/{roster_id}",
    response_model=RosterResponse,
)
async def save_roster(
    workspace_id: uuid.UUID,
    roster_id: uuid.UUID,
    payload: RosterSaveRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RosterResponse:
    """Persist a roster's schedule (debounced save). Re-indexes the flattened
    schedule text so a chat can answer "who's on Friday?" via workspace RAG."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_admin(access_role)
    roster = await _load_workspace_roster(db, ws.id, roster_id, user)
    if payload.base_revision is not None and payload.base_revision != roster.revision:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This roster was changed somewhere else. Reload to see the latest.",
        )
    prev = roster.data if isinstance(roster.data, dict) else {}
    data = dict(payload.data) if isinstance(payload.data, dict) else payload.data
    # The published snapshot is server-owned — a client save never drops it.
    if isinstance(data, dict) and "published_shifts" in prev:
        data["published_shifts"] = prev["published_shifts"]
    roster.data = data
    roster.revision = (roster.revision or 0) + 1
    # The schedule's text is rendered here, dated and windowed around today
    # (R-174), rather than taken from whichever browser saved last.
    text = await roster_context_text(db, ws, roster)
    text_changed = text != roster.content_text
    roster.content_text = text
    roster_item = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.ref_id == roster.id,
                WorkspaceItem.kind == "roster",
            )
        )
    ).scalars().first()
    if payload.title is not None and payload.title.strip():
        new_title = payload.title.strip()
        roster.title = new_title
        if roster_item is not None:
            roster_item.title = new_title
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(roster)
    if text_changed and roster_item is not None:
        from app.workspaces.knowledge import index_roster_for_workspace

        background.add_task(index_roster_for_workspace, ws.id, roster_item.id)
    return RosterResponse.model_validate(roster)


async def roster_member_names(db: AsyncSession, ws: Workspace) -> dict[str, str]:
    from app.workspaces.shares import load_workspace_participants

    parts = await load_workspace_participants(ws, db)
    names = {str(parts.owner.user_id): parts.owner.username}
    for c in parts.collaborators:
        names[str(c.user_id)] = c.username
    return names


async def roster_context_text(db: AsyncSession, ws: Workspace, roster: Roster) -> str:
    from app.workspaces.roster_text import flatten_roster

    return flatten_roster(roster.title or "Roster", roster.data, await roster_member_names(db, ws))


class RosterPublishRequest(BaseModel):
    data: Any
    base_revision: int | None = None


@router.post(
    "/{workspace_id}/rosters/{roster_id}/publish",
    response_model=RosterResponse,
)
async def publish_roster(
    workspace_id: uuid.UUID,
    roster_id: uuid.UUID,
    payload: RosterPublishRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RosterResponse:
    """Save the roster and publish it: staff now see this version, and
    everyone whose shifts changed since the last publish is told (R-174)."""
    from app.workspaces.roster_text import publish_diff

    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_admin(access_role)
    roster = await _load_workspace_roster(db, ws.id, roster_id, user)
    if payload.base_revision is not None and payload.base_revision != roster.revision:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This roster was changed somewhere else. Reload to see the latest.",
        )
    prev = roster.data if isinstance(roster.data, dict) else {}
    old_published = [s for s in (prev.get("published_shifts") or []) if isinstance(s, dict)]
    data = dict(payload.data) if isinstance(payload.data, dict) else {}
    shifts = [s for s in (data.get("shifts") or []) if isinstance(s, dict)]
    now = datetime.now(timezone.utc)
    settings = dict(data.get("settings") or {})
    settings.update({"published": True, "publishedAt": now.isoformat()})
    data["settings"] = settings
    data["published_shifts"] = shifts
    roster.data = data
    roster.revision = (roster.revision or 0) + 1
    roster.content_text = await roster_context_text(db, ws, roster)
    ws.updated_at = now
    roster_item = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.ref_id == roster.id, WorkspaceItem.kind == "roster"
            )
        )
    ).scalars().first()
    await db.commit()
    await db.refresh(roster)

    names = await roster_member_names(db, ws)
    diff = publish_diff(old_published, shifts)
    from app.notifications import notify_user

    for pid, d in diff.items():
        if pid not in names or pid == str(user.id):
            continue
        what = []
        if d["added"]:
            what.append(f"{d['added']} new or changed")
        if d["removed"] and not d["added"]:
            what.append(f"{d['removed']} removed")
        try:
            await notify_user(
                user_id=uuid.UUID(pid),
                category="assignment",
                title=f"Your shifts in “{roster.title or 'Roster'}” changed",
                body=f"{user.username} published the roster — {', '.join(what) or 'updated'} shift(s).",
                url=f"/workspaces/{ws.id}?item={roster_item.id}" if roster_item else f"/workspaces/{ws.id}",
                tag=f"promptly-roster-{roster.id}-{pid}",
                actor_user_id=user.id,
                workspace_id=ws.id,
            )
        except Exception:  # noqa: BLE001 — a failed push never fails the publish
            logger.warning("roster publish notification failed", exc_info=True)
    if roster_item is not None:
        from app.workspaces.knowledge import index_roster_for_workspace

        background.add_task(index_roster_for_workspace, ws.id, roster_item.id)
    return RosterResponse.model_validate(roster)


# Match the document/canvas collab token lifetime so the frontend's refresh
# scheduling is identical across all three editor types.
_SHEET_TOKEN_TTL_SECONDS = 5 * 60


def _mint_sheet_token(
    *, sheet_id: uuid.UUID, user: User, perm: str, epoch: int = 0
) -> tuple[str, int]:
    """A short-lived HS256 JWT the collab server validates for ``sheet:<id>``
    rooms — mirrors the canvas token, with ``type='sheet'``/``sheet_id``."""
    settings = get_settings()
    now = int(time.time())
    exp = now + _SHEET_TOKEN_TTL_SECONDS
    from app.auth.avatars import avatar_url_for

    payload = {
        "sub": str(user.id),
        "type": "sheet",
        "sheet_id": str(sheet_id),
        "perm": perm,
        "epoch": epoch,
        "name": user.username,
        # Chosen profile colour wins; palette hash is the fallback.
        "color": user.avatar_color or _color_for_user(user.id),
        "avatar": avatar_url_for(user),
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
    ws, _access_role = await get_accessible_workspace(workspace_id, user, db)
    sheet = await _load_workspace_spreadsheet(db, ws.id, sheet_id, user)
    # Same answer as the unified endpoint (WP-3.2).
    from app.files.office_router import office_token_response

    shell = await db.get(UserFile, sheet.file_id)
    if shell is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sheet not found")
    return await office_token_response(db, shell, user)


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
        last_status=ws.memory_last_status,
        last_error=ws.memory_last_error,
        last_attempt_at=ws.memory_last_attempt_at,
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
    # Memory is shared by every member and injected into their chats,
    # so rewriting it is an admin action (matches the settings UI).
    require_workspace_admin(access_role)
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
        last_status=ws.memory_last_status,
        last_error=ws.memory_last_error,
        last_attempt_at=ws.memory_last_attempt_at,
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
    # Memory is shared by every member and injected into their chats,
    # so rewriting it is an admin action (matches the settings UI).
    require_workspace_admin(access_role)
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
        last_status=ws.memory_last_status,
        last_error=ws.memory_last_error,
        last_attempt_at=ws.memory_last_attempt_at,
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
    # Memory is shared by every member and injected into their chats,
    # so rewriting it is an admin action (matches the settings UI).
    require_workspace_admin(access_role)
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
        last_status=ws.memory_last_status,
        last_error=ws.memory_last_error,
        last_attempt_at=ws.memory_last_attempt_at,
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
    item = await _load_item(db, ws.id, item_id, user)
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
    item = await _load_item(db, ws.id, item_id, user)
    _require_roster_admin(item.kind, access_role)

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
    discussion_context_change: bool | None = None
    if "context_enabled" in sent and payload.context_enabled is not None:
        # Note/canvas/board items participate in RAG context; folders/chats
        # carry the flag harmlessly but it's never consulted for them.
        # Discussions are the opt-in case: nothing is embedded until this
        # flips ON, and flipping it OFF purges what was embedded.
        if (
            item.kind == "discussion"
            and bool(item.context_enabled) != bool(payload.context_enabled)
        ):
            discussion_context_change = bool(payload.context_enabled)
        item.context_enabled = payload.context_enabled
    if "pinned" in sent and payload.pinned is not None:
        item.pinned = payload.pinned
    if "config" in sent:
        # Kind-specific config (boards: label registry / columns).
        item.config = _merge_client_config(item.config, payload.config)
        if item.kind == "board":
            await reconcile_board_cards(db, item)
    if "visibility" in sent and payload.visibility is not None:
        if payload.visibility not in ("workspace", "private"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="visibility must be 'workspace' or 'private'.",
            )
        # Only the creator can flip a draft's visibility — anyone else
        # can't even see a private item (0134). Folders/notebooks stay
        # workspace-visible in v1: hiding a subtree container while its
        # children remain addressable would be a lie.
        if item.kind in ("folder", "container"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Folders and notebooks can't be private.",
            )
        if item.created_by != user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the item's creator can change its visibility.",
            )
        item.visibility = payload.visibility

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

    # Discussions are opt-in: turning the toggle ON embeds the transcript for
    # the first time, turning it OFF purges the chunks + backing file. Both
    # run in the background and are best-effort — a toggle must never 500.
    if discussion_context_change is not None:
        try:
            from app.workspaces.knowledge import (
                index_discussion_for_workspace,
                purge_discussion_index,
            )

            if discussion_context_change:
                background.add_task(
                    index_discussion_for_workspace, ws.id, item.id
                )
            else:
                background.add_task(purge_discussion_index, ws.id, item.id)
        except Exception:  # noqa: BLE001 - never fail the toggle
            logger.warning(
                "discussion context toggle indexing failed", exc_info=True
            )

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
    # Only the chat's own creator may put its transcript into the shared
    # pool — indexing writes the transcript into the workspace owner's
    # Drive and makes it retrievable by every member (roadmap R-039).
    if conv is None or conv.workspace_id != ws.id or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat not found in this workspace",
        )
    if payload.enabled and conv.visibility != "workspace":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Share this chat with the workspace before using it as context.",
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
    item = await _load_item(db, ws.id, item_id, user)

    if payload.parent_id == item.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An item can't be moved inside itself.",
        )
    # The item's own kind, so a notebook can't be moved into a notebook —
    # the create path checked it but a move didn't (R-181).
    await _validate_parent(db, ws.id, payload.parent_id, child_kind=item.kind)

    item.parent_id = payload.parent_id
    item.position = payload.position
    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return WorkspaceItemResponse.model_validate(item)


# ---------------------------------------------------------------------
# Placement of synthesised nodes (0140) — chats + automations have no
# workspace_items row, so they carry their own parent/position columns.
# These endpoints let the navigator drag them like any tree item.
# ---------------------------------------------------------------------
async def _validate_placement_parent(
    db: AsyncSession, workspace_id: uuid.UUID, parent_id: uuid.UUID | None
) -> None:
    """A synthesised node (chat / automation) lives at the top level of the
    workspace. Folders — their only former nest target — were removed, and a
    notebook holds backing-item *pages* (a synthesised node has no item row to
    render as a page), so nesting isn't supported: the parent must be root.

    ``db`` / ``workspace_id`` are retained for signature stability with the
    ``/place`` callers even though the root-only rule no longer needs a lookup.
    """
    if parent_id is None:
        return
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            "Chats and automations can't be nested — they live at the top "
            "level of the workspace."
        ),
    )


@router.post(
    "/{workspace_id}/chats/{conversation_id}/place",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def place_workspace_chat(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    payload: WorkspaceItemMove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Reorder / file a workspace chat in the navigator (0140)."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.workspace_id != ws.id or conv.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    await _validate_placement_parent(db, ws.id, payload.parent_id)
    conv.ws_parent_id = payload.parent_id
    conv.ws_position = payload.position
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{workspace_id}/tasks/{task_id}/place",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def place_workspace_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: WorkspaceItemMove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Reorder / file a workspace automation in the navigator (0140)."""
    from app.tasks.models import Task

    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await db.get(Task, task_id)
    if task is None or task.workspace_id != ws.id or task.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    await _validate_placement_parent(db, ws.id, payload.parent_id)
    task.ws_parent_id = payload.parent_id
    task.ws_position = payload.position
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    item = await _load_item(db, ws.id, item_id, user)
    _require_roster_admin(item.kind, access_role)
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
    item = await _load_item(db, ws.id, item_id, user)
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
                    WorkspaceItem.trashed_at.is_(None),
                    item_visible_to(user.id),
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
                    conversation_visible_to(user.id),
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
    await _load_item(db, ws.id, item_id, user)
    needle = f"item={item_id}"

    notes = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind == "note",
                    WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.trashed_at.is_(None),
                    # Someone else's private note linking here mustn't
                    # surface its title (R-168).
                    item_visible_to(user.id),
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete an item. Deleting a folder removes its whole subtree (the
    ``parent_id`` FK cascades the rows); every ``note`` in that subtree
    has its backing Drive Document moved to Trash first so the blob
    isn't orphaned but is still recoverable from the Files page.

    Since 0138 this is a *soft* delete: the item (and its subtree) is
    stamped ``trashed_at`` and vanishes from the tree / AI map /
    retrieval / search, but nothing is torn down until it's purged from
    the Trash section (explicitly, or lazily after 30 days)."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id, user)
    _require_roster_admin(item.kind, access_role)

    now = datetime.now(timezone.utc)
    for it in await _collect_subtree(db, ws.id, item):
        it.trashed_at = now
    ws.updated_at = now
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Note from template (9.3) — builtin skeletons + notes flagged as
# templates (``config.template``). Both land as a fresh collaborative
# note; content fidelity for user templates goes HTML → Markdown → Y.Doc
# (structural docs survive that round-trip fine).
# ---------------------------------------------------------------------
class NoteFromTemplateRequest(BaseModel):
    # Exactly one of these picks the source.
    template_key: str | None = None
    from_item_id: uuid.UUID | None = None
    title: str | None = None
    parent_id: uuid.UUID | None = None


@router.post(
    "/{workspace_id}/items/note-from-template",
    response_model=WorkspaceItemResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_note_from_template(
    workspace_id: uuid.UUID,
    payload: NoteFromTemplateRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    from datetime import date as date_cls

    from app.files.documents_router import _html_to_markdown
    from app.files.storage import absolute_path
    from app.workspaces.content_seed import create_note_with_item
    from app.workspaces.knowledge import index_note_for_workspace
    from app.workspaces.templates import NOTE_TEMPLATES

    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    await _validate_parent(db, ws.id, payload.parent_id, "note")

    if payload.template_key is not None:
        entry = NOTE_TEMPLATES.get(payload.template_key)
        if entry is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown template.",
            )
        default_title, markdown = entry
        markdown = markdown.replace(
            "{date}", date_cls.today().strftime("%d %b %Y")
        )
        title = (payload.title or "").strip() or default_title
    elif payload.from_item_id is not None:
        src = await _load_item(db, ws.id, payload.from_item_id, user)
        if src.kind != "note" or src.ref_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Only notes can be used as templates.",
            )
        uf = await db.get(UserFile, src.ref_id)
        html = ""
        if uf is not None:
            try:
                html = absolute_path(uf.storage_path).read_text(
                    encoding="utf-8"
                )
            except (OSError, ValueError):
                html = ""
        markdown = _html_to_markdown(html) or (
            uf.content_text if uf else ""
        ) or ""
        title = (payload.title or "").strip() or src.title
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Pick a builtin template or a template note.",
        )

    owner = user if ws.user_id == user.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE, detail="Workspace owner missing."
        )
    item = await create_note_with_item(
        db,
        ws=ws,
        owner=owner,
        creator_id=user.id,
        title=title[:200],
        markdown=markdown,
        parent_id=payload.parent_id,
    )
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    background.add_task(index_note_for_workspace, ws.id, item.id)
    return WorkspaceItemResponse.model_validate(item)


# ---------------------------------------------------------------------
# Trash (0138) — list / restore / purge
# ---------------------------------------------------------------------

# Items sitting in the trash longer than this are purged the next time
# anyone looks at the trash — no background sweeper needed.
_TRASH_RETENTION_DAYS = 30


class TrashEntry(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    trashed_at: datetime
    # How many nested items ride along on restore/purge.
    subtree_count: int = 0


async def _trash_roots(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[WorkspaceItem, int]]:
    """Trashed subtree roots + how many descendants each carries."""
    trashed = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == workspace_id,
                    WorkspaceItem.trashed_at.is_not(None),
                )
                .order_by(WorkspaceItem.trashed_at.desc())
            )
        ).scalars()
    )
    trashed_ids = {it.id for it in trashed}
    by_parent: dict[uuid.UUID | None, list[WorkspaceItem]] = {}
    for it in trashed:
        by_parent.setdefault(it.parent_id, []).append(it)

    def _count(root: WorkspaceItem) -> int:
        n = 0
        stack = list(by_parent.get(root.id, []))
        while stack:
            cur = stack.pop()
            n += 1
            stack.extend(by_parent.get(cur.id, []))
        return n

    return [
        (it, _count(it))
        for it in trashed
        if it.parent_id is None or it.parent_id not in trashed_ids
    ]


async def _purge_item(
    db: AsyncSession,
    *,
    request: Request,
    ws,
    user: User,
    item: WorkspaceItem,
) -> None:
    """Permanently destroy an item + subtree (the pre-0138 delete body).

    Trashes note blobs into the Drive trash, drops sheet/canvas/chat
    backing rows, purges RAG chunks, writes the audit row, and deletes
    the item rows (descendants cascade via the self-FK). Flushes; the
    caller commits."""
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
        elif it.kind == "roster" and it.ref_id is not None:
            # Sheet-style backing row (Roster): drop the backing row and trash
            # its RAG text file, so a deleted item stops surfacing in retrieval.
            backing_model = {
                "roster": Roster,
            }[it.kind]
            backing = await db.get(backing_model, it.ref_id)
            if backing is not None:
                if backing.text_file_id is not None:
                    bf = await db.get(UserFile, backing.text_file_id)
                    if bf is not None and bf.trashed_at is None:
                        bf.trashed_at = now
                    chunk_file_ids.add(backing.text_file_id)
                await db.delete(backing)
        elif it.kind == "discussion":
            # A discussion has no backing row — its (opt-in) RAG transcript
            # file id lives in ``config['text_file_id']``. Threads/messages
            # cascade off the item FK; the file + chunks don't.
            from app.workspaces.knowledge import load_discussion_backing_file

            # Only trash it once it's proven to be this discussion's own
            # transcript — the pointer must never become a way to trash
            # an arbitrary file.
            df = await load_discussion_backing_file(
                db, owner_user_id=ws.user_id, item=it
            )
            if df is not None:
                if df.trashed_at is None:
                    df.trashed_at = now
                chunk_file_ids.add(df.id)

    # Purge the RAG chunks for every backing file we just retired so a
    # deleted item stops contributing to retrieval (and to the indexed-token
    # total that flips the workspace into retrieval mode).
    if chunk_file_ids:
        from app.custom_models.ingestion import delete_existing_chunks

        for fid in chunk_file_ids:
            await delete_existing_chunks(
                db, scope_kind="workspace", scope_id=ws.id, user_file_id=fid
            )

    from app.auth.audit import record_event
    from app.auth.events import EVENT_WORKSPACE_ITEM_DELETED

    subtree = (
        f" (+{len(doomed) - 1} nested item(s))" if len(doomed) > 1 else ""
    )
    await record_event(
        db,
        event_type=EVENT_WORKSPACE_ITEM_DELETED,
        request=request,
        user_id=user.id,
        detail=f'{item.kind} "{item.title}"{subtree} in "{ws.title}" '
        f"(ws={ws.id})",
    )
    # Deleting the top row cascades the descendant item rows via the
    # self-FK ON DELETE CASCADE.
    await db.delete(item)
    ws.updated_at = now


@router.get("/{workspace_id}/trash", response_model=list[TrashEntry])
async def list_workspace_trash(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[TrashEntry]:
    """Trashed subtree roots, newest first. Anything past the retention
    window is purged on the way through — the lazy sweeper."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    roots = await _trash_roots(db, ws.id)

    cutoff = datetime.now(timezone.utc) - timedelta(
        days=_TRASH_RETENTION_DAYS
    )
    expired = [it for it, _n in roots if it.trashed_at and it.trashed_at < cutoff]
    if expired:
        for it in expired:
            await _purge_item(db, request=request, ws=ws, user=user, item=it)
        await db.commit()
        roots = await _trash_roots(db, ws.id)

    # The sweeper above purges everyone's expired items; the *listing* only
    # shows what the caller may see — never another member's private draft.
    roots = [
        (it, n)
        for it, n in roots
        if it.visibility != "private" or it.created_by == user.id
    ]
    return [
        TrashEntry(
            id=it.id,
            kind=it.kind,
            title=it.title,
            trashed_at=it.trashed_at,  # type: ignore[arg-type]
            subtree_count=n,
        )
        for it, n in roots
    ]


@router.post(
    "/{workspace_id}/trash/{item_id}/restore",
    response_model=WorkspaceItemResponse,
)
async def restore_trashed_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceItemResponse:
    """Bring an item (+ its subtree) back from the trash. If its old
    parent folder was itself trashed or purged, it lands at the root."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id, user)
    now = datetime.now(timezone.utc)
    for it in await _collect_subtree(db, ws.id, item):
        it.trashed_at = None
    # Re-root when the parent is gone or still in the trash — otherwise
    # the restored item would be invisible (tree renders from live roots).
    if item.parent_id is not None:
        parent = await db.get(WorkspaceItem, item.parent_id)
        if parent is None or parent.trashed_at is not None:
            item.parent_id = None
            item.position = await _next_position(db, ws.id, None)
    ws.updated_at = now
    await db.commit()
    await db.refresh(item)
    return WorkspaceItemResponse.model_validate(item)


@router.delete(
    "/{workspace_id}/trash/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def purge_trashed_item(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Permanently delete a trashed item — the point of no return."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    item = await _load_item(db, ws.id, item_id, user)
    if item.trashed_at is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only trashed items can be permanently deleted.",
        )
    await _purge_item(db, request=request, ws=ws, user=user, item=item)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]

"""Programmatic workspace content creation (shared recipe).

One canonical implementation of "create a note in a workspace from
Markdown" — used by chat write-back proposals (4.1) and workspace
templates (4.6). The automation graph_runner predates this module and
keeps its own copy; fold it in when that file is next touched.

Everything here flushes but does not commit — callers own the
transaction so multi-item seeding is atomic.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Workspace, WorkspaceItem

logger = logging.getLogger("promptly.workspaces.seed")


async def create_note_with_item(
    db: AsyncSession,
    *,
    ws: Workspace,
    owner: User,
    creator_id: uuid.UUID,
    title: str,
    markdown: str,
    parent_id: uuid.UUID | None = None,
) -> WorkspaceItem:
    """Create a Drive-backed note seeded from Markdown + its tree item.

    Mirrors a normal editor save end-to-end: Y.Doc seed (so the collab
    editor opens populated), HTML blob (preview/download), content_text
    (FTS + RAG), ``queued`` index status. Flushed, not committed.
    """
    from app.files.document_build import markdown_to_doc_update
    from app.files.document_render import (
        extract_text_from_html,
        render_html_from_update,
    )
    from app.files.documents_router import create_blank_document
    from app.files.models import DocumentState
    from app.files.storage import absolute_path
    from app.workspaces.items_router import (
        _next_position,
        _resolve_subfolder_id,
    )

    title = (title or "Untitled note").strip()[:200]
    notes_folder_id = await _resolve_subfolder_id(db, ws, owner, "Notes")
    doc = await create_blank_document(
        db, owner_id=owner.id, folder_id=notes_folder_id, name=title
    )
    update = markdown_to_doc_update(markdown)
    ds = await db.get(DocumentState, doc.id)
    if ds is not None:
        ds.yjs_update = update
        ds.version = (ds.version or 0) + 1
    html = render_html_from_update(update)
    doc.content_text = extract_text_from_html(html) or None
    try:
        with open(absolute_path(doc.storage_path), "w", encoding="utf-8") as f:
            f.write(html)
        doc.size_bytes = len(html.encode("utf-8"))
    except OSError:
        logger.warning("seeded note blob write failed", exc_info=True)

    pos = await _next_position(db, ws.id, parent_id)
    item = WorkspaceItem(
        workspace_id=ws.id,
        parent_id=parent_id,
        kind="note",
        ref_id=doc.id,
        title=title,
        position=pos,
        indexing_status="queued",
        created_by=creator_id,
    )
    db.add(item)
    await db.flush()
    return item


async def create_board_with_labels(
    db: AsyncSession,
    *,
    ws: Workspace,
    creator_id: uuid.UUID,
    title: str,
    labels: list[dict[str, Any]] | None = None,
) -> WorkspaceItem:
    """Create a board item, optionally pre-seeding its label registry.

    Labels are ``{"name": …, "color": …}`` — ids are minted here so the
    template definitions stay readable. Flushed, not committed.
    """
    from app.workspaces.items_router import _next_position

    config: dict[str, Any] | None = None
    if labels:
        config = {
            "labels": [
                {
                    "id": uuid.uuid4().hex[:8],
                    "name": str(l["name"])[:40],
                    "color": str(l.get("color") or "#4F46E5"),
                }
                for l in labels
            ]
        }
    pos = await _next_position(db, ws.id, None)
    item = WorkspaceItem(
        workspace_id=ws.id,
        parent_id=None,
        kind="board",
        ref_id=None,
        title=(title or "Board").strip()[:200],
        position=pos,
        config=config,
        created_by=creator_id,
    )
    db.add(item)
    await db.flush()
    return item

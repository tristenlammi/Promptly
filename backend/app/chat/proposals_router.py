"""Workspace write-back proposals API (Batch 4.1).

    GET  /chat/conversations/{id}/proposals   pending + recent proposals
    POST /chat/proposals/{id}/apply           execute the change
    POST /chat/proposals/{id}/dismiss         reject it

The AI's workspace tools only ever *file* proposals; this router is
where a human turns one into a real note / board cards. Apply
re-validates against the current workspace state (the board may have
been deleted since, the workspace may be gone) — a stale proposal
fails softly with a readable error rather than half-applying.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import (
    Workspace,
    WorkspaceItem,
    WorkspaceProposal,
    WorkspaceTask,
)
from app.database import get_db

logger = logging.getLogger("promptly.chat.proposals")

router = APIRouter()


class ProposalRow(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    workspace_id: uuid.UUID
    kind: str
    payload: dict[str, Any]
    status: str
    applied_item_id: uuid.UUID | None = None
    created_at: datetime
    resolved_at: datetime | None = None


def _to_row(p: WorkspaceProposal) -> ProposalRow:
    return ProposalRow(
        id=p.id,
        conversation_id=p.conversation_id,
        workspace_id=p.workspace_id,
        kind=p.kind,
        payload=p.payload,
        status=p.status,
        applied_item_id=p.applied_item_id,
        created_at=p.created_at,
        resolved_at=p.resolved_at,
    )


@router.get(
    "/conversations/{conversation_id}/proposals",
    response_model=list[ProposalRow],
)
async def list_proposals(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ProposalRow]:
    """The chat's proposals, pending first then recently resolved (the
    card list keeps a short trail so "Applied" states survive reloads)."""
    rows = (
        (
            await db.execute(
                select(WorkspaceProposal)
                .where(
                    WorkspaceProposal.conversation_id == conversation_id,
                    WorkspaceProposal.user_id == user.id,
                )
                .order_by(WorkspaceProposal.created_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    pending = [p for p in rows if p.status == "pending"]
    resolved = [p for p in rows if p.status != "pending"][:5]
    return [_to_row(p) for p in [*pending, *resolved]]


async def _load_owned_pending(
    db: AsyncSession, proposal_id: uuid.UUID, user: User
) -> WorkspaceProposal:
    p = await db.get(WorkspaceProposal, proposal_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Proposal not found"
        )
    if p.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Proposal already {p.status}.",
        )
    return p


@router.post("/proposals/{proposal_id}/dismiss", response_model=ProposalRow)
async def dismiss_proposal(
    proposal_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ProposalRow:
    p = await _load_owned_pending(db, proposal_id, user)
    p.status = "dismissed"
    p.resolved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(p)
    return _to_row(p)


@router.post("/proposals/{proposal_id}/apply", response_model=ProposalRow)
async def apply_proposal(
    proposal_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ProposalRow:
    p = await _load_owned_pending(db, proposal_id, user)
    ws = await db.get(Workspace, p.workspace_id)
    if ws is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="The workspace no longer exists.",
        )
    if p.kind == "create_note":
        item_id = await _apply_create_note(db, ws=ws, user=user, payload=p.payload)
    elif p.kind == "add_cards":
        item_id = await _apply_add_cards(
            db, background, ws=ws, user=user, payload=p.payload
        )
    else:  # pragma: no cover — future kinds
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown proposal kind '{p.kind}'.",
        )
    p.status = "applied"
    p.applied_item_id = item_id
    p.resolved_at = datetime.now(timezone.utc)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(p)
    return _to_row(p)


# ---------------------------------------------------------------------
# Executors — same recipe as the automation output nodes, but scoped to
# the approving user (they get authorship of what lands).
# ---------------------------------------------------------------------
async def _apply_create_note(
    db: AsyncSession, *, ws: Workspace, user: User, payload: dict[str, Any]
) -> uuid.UUID:
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

    title = str(payload.get("title") or "Untitled note").strip()[:200]
    markdown = str(payload.get("markdown") or "")
    owner = user if ws.user_id == user.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE, detail="Workspace owner missing."
        )

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
        logger.warning("proposal note blob write failed", exc_info=True)

    pos = await _next_position(db, ws.id, None)
    item = WorkspaceItem(
        workspace_id=ws.id,
        parent_id=None,
        kind="note",
        ref_id=doc.id,
        title=title,
        position=pos,
        indexing_status="queued",
        created_by=user.id,
    )
    db.add(item)
    await db.flush()

    try:
        from app.workspaces.knowledge import index_note_for_workspace

        await index_note_for_workspace(ws.id, item.id)
    except Exception:  # noqa: BLE001 — indexing must never fail the apply
        logger.warning("proposal note index failed", exc_info=True)
    return item.id


async def _apply_add_cards(
    db: AsyncSession,
    background: BackgroundTasks,
    *,
    ws: Workspace,
    user: User,
    payload: dict[str, Any],
) -> uuid.UUID:
    board_id = uuid.UUID(str(payload.get("board_item_id")))
    board = await db.get(WorkspaceItem, board_id)
    if board is None or board.workspace_id != ws.id or board.kind != "board":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="The target board no longer exists — dismiss this proposal.",
        )
    max_pos = await db.scalar(
        select(func.max(WorkspaceTask.position)).where(
            WorkspaceTask.board_item_id == board.id
        )
    )
    pos = float(max_pos or 0.0)
    for card in payload.get("cards") or []:
        pos += 1.0
        due_at = None
        raw_due = str(card.get("due_date") or "").strip()
        if raw_due:
            try:
                due_at = datetime.fromisoformat(raw_due).replace(
                    tzinfo=timezone.utc
                )
            except ValueError:
                due_at = None
        db.add(
            WorkspaceTask(
                workspace_id=ws.id,
                board_item_id=board.id,
                title=str(card.get("title") or "Untitled")[:200],
                description=str(card.get("description") or "") or None,
                status="todo",
                priority=(
                    card.get("priority")
                    if card.get("priority") in ("low", "medium", "high")
                    else "medium"
                ),
                due_at=due_at,
                position=pos,
                created_by=user.id,
            )
        )
    await db.flush()
    try:
        from app.workspaces.knowledge import index_board_for_workspace

        background.add_task(index_board_for_workspace, ws.id, board.id)
    except Exception:  # noqa: BLE001
        logger.warning("proposal board reindex enqueue failed", exc_info=True)
    return board.id


__all__ = ["router"]

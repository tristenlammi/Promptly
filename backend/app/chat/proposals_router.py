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
    """Remove a proposal card from the chat. For a *pending* proposal this
    rejects it (nothing was written). For an *already-applied* one it just
    clears the banner — the change stays on the board/note; only the chat
    trail is tidied."""
    p = await db.get(WorkspaceProposal, proposal_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Proposal not found"
        )
    if p.status == "dismissed":
        return _to_row(p)  # already gone — idempotent
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
    elif p.kind == "update_cards":
        item_id = await _apply_update_cards(
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
    from app.workspaces.content_seed import (
        create_note_with_item,
        resolve_or_create_notebook,
    )

    title = str(payload.get("title") or "Untitled note").strip()[:200]
    markdown = str(payload.get("markdown") or "")
    owner = user if ws.user_id == user.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE, detail="Workspace owner missing."
        )

    # Optional: file the note inside a notebook (created if missing) so the AI
    # can keep e.g. a "Campaign Archive" group instead of cluttering the root.
    parent_id: uuid.UUID | None = None
    notebook = str(payload.get("notebook") or "").strip()
    if notebook:
        try:
            parent_id = await resolve_or_create_notebook(
                db, ws=ws, creator_id=user.id, name=notebook
            )
        except ValueError:
            parent_id = None

    item = await create_note_with_item(
        db,
        ws=ws,
        owner=owner,
        creator_id=user.id,
        title=title,
        markdown=markdown,
        parent_id=parent_id,
    )
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


async def _apply_update_cards(
    db: AsyncSession,
    background: BackgroundTasks,
    *,
    ws: Workspace,
    user: User,
    payload: dict[str, Any],
) -> uuid.UUID:
    """Apply an ``update_cards`` proposal: push the snapshotted ``changes``
    onto each still-present card. Cards that vanished since the proposal was
    filed are skipped (best-effort bulk edit), and ``status`` moves keep the
    legacy ``done`` flag + ``completed_at`` in lockstep the same way the
    board's own PATCH does."""
    from app.workspaces.tasks_router import _is_done_status

    board_id = uuid.UUID(str(payload.get("board_item_id")))
    board = await db.get(WorkspaceItem, board_id)
    if board is None or board.workspace_id != ws.id or board.kind != "board":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="The target board no longer exists — dismiss this proposal.",
        )
    changes = payload.get("changes") or {}
    now = datetime.now(timezone.utc)
    for raw_id in payload.get("card_ids") or []:
        try:
            task_id = uuid.UUID(str(raw_id))
        except (ValueError, TypeError):
            continue
        task = await db.get(WorkspaceTask, task_id)
        if task is None or task.board_item_id != board.id:
            continue
        if "status" in changes:
            task.status = str(changes["status"])
            task.done = await _is_done_status(db, board.id, task.status)
            task.completed_at = now if task.done else None
        if changes.get("priority") in ("low", "medium", "high"):
            task.priority = changes["priority"]
        if "due_date" in changes:
            raw_due = changes["due_date"]
            if raw_due is None:
                task.due_at = None
            else:
                try:
                    task.due_at = datetime.fromisoformat(str(raw_due)).replace(
                        tzinfo=timezone.utc
                    )
                except ValueError:
                    pass  # leave the existing due date untouched
    await db.flush()
    try:
        from app.workspaces.knowledge import index_board_for_workspace

        background.add_task(index_board_for_workspace, ws.id, board.id)
    except Exception:  # noqa: BLE001
        logger.warning("proposal board reindex enqueue failed", exc_info=True)
    return board.id


__all__ = ["router"]

"""Workspace overview home (Phase 4).

``GET /api/workspaces/{wid}/overview`` powers the workspace landing pane
shown when no item is selected: at-a-glance counts, a **tasks rollup**
(open checkboxes aggregated from every note in the workspace), and a few
recently-touched items. One cheap request the frontend renders as the
"home" of the workspace.
"""
from __future__ import annotations

import html as html_module
import re
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, WorkspaceItem
from app.database import get_db
from app.files.models import UserFile
from app.files.storage import absolute_path
from app.workspaces.shares import get_accessible_workspace

router = APIRouter()

# Task-list items rendered by TipTap carry ``data-checked="true|false"``.
# Non-greedy capture of one ``<li>``; good enough for the flat task lists
# notes produce (nested task lists are rare and degrade gracefully).
_TASK_RE = re.compile(
    r'<li[^>]*data-checked="(true|false)"[^>]*>(.*?)</li>',
    re.DOTALL | re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")

# Caps so a workspace with huge notes can't make the overview slow.
_MAX_NOTES_SCANNED = 50
_MAX_TASKS = 60


class TaskRollupItem(BaseModel):
    text: str
    checked: bool
    note_item_id: uuid.UUID
    # The note's backing document id, so the UI can open it on click.
    note_ref_id: uuid.UUID | None
    note_title: str


class OverviewCounts(BaseModel):
    notes: int = 0
    canvases: int = 0
    chats: int = 0
    files: int = 0


class RecentItem(BaseModel):
    id: uuid.UUID
    kind: str
    ref_id: uuid.UUID | None
    title: str


class WorkspaceOverview(BaseModel):
    counts: OverviewCounts
    tasks: list[TaskRollupItem] = Field(default_factory=list)
    open_task_count: int = 0
    recent: list[RecentItem] = Field(default_factory=list)


def _extract_tasks(rendered_html: str) -> list[tuple[bool, str]]:
    out: list[tuple[bool, str]] = []
    for checked, inner in _TASK_RE.findall(rendered_html):
        text = html_module.unescape(_TAG_RE.sub("", inner)).strip()
        if text:
            out.append((checked == "true", text))
    return out


@router.get("/{workspace_id}/overview", response_model=WorkspaceOverview)
async def workspace_overview(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceOverview:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    # --- Counts (live items only) ---------------------------------------
    async def _count_kind(kind: str) -> int:
        return int(
            await db.scalar(
                select(func.count())
                .select_from(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind == kind,
                    WorkspaceItem.archived_at.is_(None),
                )
            )
            or 0
        )

    counts = OverviewCounts(
        notes=await _count_kind("note"),
        canvases=await _count_kind("canvas"),
        files=await _count_kind("file"),
        chats=int(
            await db.scalar(
                select(func.count())
                .select_from(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.archived_at.is_(None),
                )
            )
            or 0
        ),
    )

    # --- Tasks rollup: scan every live note's HTML for checkboxes --------
    note_items = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind == "note",
                    WorkspaceItem.archived_at.is_(None),
                )
                .order_by(WorkspaceItem.position.asc())
                .limit(_MAX_NOTES_SCANNED)
            )
        ).scalars()
    )
    tasks: list[TaskRollupItem] = []
    open_count = 0
    for item in note_items:
        if item.ref_id is None or len(tasks) >= _MAX_TASKS:
            continue
        uf = await db.get(UserFile, item.ref_id)
        if uf is None:
            continue
        try:
            rendered = absolute_path(uf.storage_path).read_text(encoding="utf-8")
        except OSError:
            continue
        for checked, text in _extract_tasks(rendered):
            if not checked:
                open_count += 1
            if len(tasks) < _MAX_TASKS:
                tasks.append(
                    TaskRollupItem(
                        text=text[:300],
                        checked=checked,
                        note_item_id=item.id,
                        note_ref_id=item.ref_id,
                        note_title=item.title,
                    )
                )
    # Open tasks first, then completed — the actionable ones lead.
    tasks.sort(key=lambda t: t.checked)

    # --- Recent items (notes/canvases by update, plus recent chats) -----
    recent_items = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind.in_(("note", "canvas")),
                    WorkspaceItem.archived_at.is_(None),
                )
                .order_by(WorkspaceItem.updated_at.desc())
                .limit(5)
            )
        ).scalars()
    )
    recent = [
        RecentItem(id=it.id, kind=it.kind, ref_id=it.ref_id, title=it.title)
        for it in recent_items
    ]
    recent_chats = list(
        (
            await db.execute(
                select(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.archived_at.is_(None),
                )
                .order_by(Conversation.updated_at.desc())
                .limit(3)
            )
        ).scalars()
    )
    for c in recent_chats:
        recent.append(
            RecentItem(
                id=c.id, kind="chat", ref_id=c.id, title=c.title or "New chat"
            )
        )

    return WorkspaceOverview(
        counts=counts, tasks=tasks, open_task_count=open_count, recent=recent
    )


__all__ = ["router"]

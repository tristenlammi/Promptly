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
from datetime import datetime

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
    boards: int = 0
    sheets: int = 0
    chats: int = 0
    files: int = 0


class RecentItem(BaseModel):
    id: uuid.UUID
    kind: str
    ref_id: uuid.UUID | None
    title: str
    # Freshness for the home page's resume cards.
    updated_at: datetime | None = None


class HealthItem(BaseModel):
    item_id: uuid.UUID
    kind: str
    title: str
    # Backing entity id (the note's UserFile, canvas, sheet, …). The
    # frontend needs it to actually open the item — without it a note opens
    # to "no underlying document".
    ref_id: uuid.UUID | None = None
    # Stale: last touched. Heavy: indexed characters.
    updated_at: datetime | None = None
    chars: int | None = None


class KnowledgeHealth(BaseModel):
    """The trust card (4.8): what's quietly degrading the AI's answers.

    * ``stale`` — context-enabled items untouched for 60+ days (the AI
      still cites them as if current).
    * ``heavy`` — the biggest text contributors (crowd out retrieval
      budget; candidates for the ⚡ toggle or splitting).
    """

    stale: list[HealthItem] = Field(default_factory=list)
    heavy: list[HealthItem] = Field(default_factory=list)


class WorkspaceOverview(BaseModel):
    counts: OverviewCounts
    tasks: list[TaskRollupItem] = Field(default_factory=list)
    open_task_count: int = 0
    recent: list[RecentItem] = Field(default_factory=list)
    health: KnowledgeHealth = Field(default_factory=KnowledgeHealth)


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
                    WorkspaceItem.trashed_at.is_(None),
                )
            )
            or 0
        )

    counts = OverviewCounts(
        notes=await _count_kind("note"),
        canvases=await _count_kind("canvas"),
        boards=await _count_kind("board"),
        sheets=await _count_kind("sheet"),
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
                    WorkspaceItem.trashed_at.is_(None),
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
                    WorkspaceItem.kind.in_(("note", "canvas", "board", "sheet")),
                    WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.trashed_at.is_(None),
                )
                .order_by(WorkspaceItem.updated_at.desc())
                .limit(6)
            )
        ).scalars()
    )
    recent = [
        RecentItem(
            id=it.id,
            kind=it.kind,
            ref_id=it.ref_id,
            title=it.title,
            updated_at=it.updated_at,
        )
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
                id=c.id,
                kind="chat",
                ref_id=c.id,
                title=c.title or "New chat",
                updated_at=c.updated_at,
            )
        )

    # --- Knowledge health (4.8) ------------------------------------------
    # NOTE: no local ``UserFile`` import here — it's module-level, and a
    # function-local import would shadow it for the *entire* function
    # (UnboundLocalError at the earlier tasks-rollup use).
    from datetime import timedelta, timezone as tz

    from sqlalchemy import or_ as sa_or

    from app.chat.models import Spreadsheet, WorkspaceCanvas

    visible = sa_or(
        WorkspaceItem.visibility != "private",
        WorkspaceItem.created_by == user.id,
    )
    stale_cutoff = datetime.now(tz.utc) - timedelta(days=60)
    stale_rows = (
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.trashed_at.is_(None),
                    WorkspaceItem.kind.in_(("note", "canvas", "sheet", "board")),
                    WorkspaceItem.context_enabled.is_(True),
                    WorkspaceItem.updated_at < stale_cutoff,
                    visible,
                )
                .order_by(WorkspaceItem.updated_at.asc())
                .limit(5)
            )
        )
        .scalars()
        .all()
    )
    health = KnowledgeHealth(
        stale=[
            HealthItem(
                item_id=it.id,
                kind=it.kind,
                title=it.title,
                ref_id=it.ref_id,
                updated_at=it.updated_at,
            )
            for it in stale_rows
        ]
    )
    # Heaviest text contributors: join each context item to its backing
    # file's content length. One query per backing shape, merged in Python.
    heavy: list[HealthItem] = []
    note_sizes = (
        await db.execute(
            select(WorkspaceItem, func.length(UserFile.content_text))
            .join(UserFile, UserFile.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == ws.id,
                WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.trashed_at.is_(None),
                WorkspaceItem.kind.in_(("note", "board")),
                WorkspaceItem.context_enabled.is_(True),
                UserFile.content_text.is_not(None),
                visible,
            )
        )
    ).all()
    canvas_sizes = (
        await db.execute(
            select(WorkspaceItem, func.length(WorkspaceCanvas.content_text))
            .join(WorkspaceCanvas, WorkspaceCanvas.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == ws.id,
                WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.trashed_at.is_(None),
                WorkspaceItem.kind == "canvas",
                WorkspaceItem.context_enabled.is_(True),
                WorkspaceCanvas.content_text.is_not(None),
                visible,
            )
        )
    ).all()
    sheet_sizes = (
        await db.execute(
            select(WorkspaceItem, func.length(Spreadsheet.content_text))
            .join(Spreadsheet, Spreadsheet.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == ws.id,
                WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.trashed_at.is_(None),
                WorkspaceItem.kind == "sheet",
                WorkspaceItem.context_enabled.is_(True),
                Spreadsheet.content_text.is_not(None),
                visible,
            )
        )
    ).all()
    for it, chars in [*note_sizes, *canvas_sizes, *sheet_sizes]:
        if chars and chars > 10_000:  # under ~2.5k tokens nobody cares
            heavy.append(
                HealthItem(
                    item_id=it.id,
                    kind=it.kind,
                    title=it.title,
                    ref_id=it.ref_id,
                    chars=chars,
                )
            )
    heavy.sort(key=lambda h: h.chars or 0, reverse=True)
    health.heavy = heavy[:5]

    return WorkspaceOverview(
        counts=counts,
        tasks=tasks,
        open_task_count=open_count,
        recent=recent,
        health=health,
    )


# ---------------------------------------------------------------------
# Activity feed (Batch 3 finale) — "what changed since I was last here"
# ---------------------------------------------------------------------
class ActivityActor(BaseModel):
    username: str
    avatar_url: str | None = None
    avatar_color: str | None = None


class ActivityEvent(BaseModel):
    """One feed row. ``kind`` picks the verb phrasing client-side:

    * ``item_created``  — actor created <item kind> "<title>"
    * ``item_comment``  — actor commented on "<title>" (+snippet)
    * ``card_activity`` — actor <text> on card "<title>" (system log rows)
    * ``card_comment``  — actor commented on card "<title>" (+snippet)
    """

    kind: str
    actor: ActivityActor | None = None
    # The item/board the event belongs to, for click-through.
    item_id: uuid.UUID | None = None
    item_kind: str | None = None
    item_title: str
    # Comment snippet / activity text; empty for creations.
    text: str = ""
    created_at: datetime


class ActivityResponse(BaseModel):
    events: list[ActivityEvent]


@router.get("/{workspace_id}/activity", response_model=ActivityResponse)
async def workspace_activity(
    workspace_id: uuid.UUID,
    limit: int = 40,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ActivityResponse:
    """Merged, newest-first feed of what happened in the workspace:
    item creations, item comments, and board-card comments/activity.

    Private drafts (0134) are filtered to their creator; each source is
    capped at ``limit`` before the merge so one chatty board can't
    starve the others, then the merged list is trimmed again.
    """
    from app.chat.models import (
        WorkspaceItemComment,
        WorkspaceTask,
        WorkspaceTaskComment,
    )
    from sqlalchemy import or_

    limit = max(1, min(100, limit))
    events: list[tuple] = []  # (created_at, ActivityEvent)

    def actor_of(u: User | None) -> ActivityActor | None:
        if u is None:
            return None
        return ActivityActor(
            username=u.username,
            avatar_url=u.avatar_url,
            avatar_color=u.avatar_color,
        )

    visible = or_(
        WorkspaceItem.visibility != "private",
        WorkspaceItem.created_by == user.id,
    )

    # 1) Item creations (notes / canvases / boards / sheets / folders).
    created_rows = (
        await db.execute(
            select(WorkspaceItem, User)
            .outerjoin(User, User.id == WorkspaceItem.created_by)
            .where(WorkspaceItem.workspace_id == workspace_id, visible)
            .order_by(WorkspaceItem.created_at.desc())
            .limit(limit)
        )
    ).all()
    for item, creator in created_rows:
        events.append(
            (
                item.created_at,
                ActivityEvent(
                    kind="item_created",
                    actor=actor_of(creator),
                    item_id=item.id,
                    item_kind=item.kind,
                    item_title=item.title,
                    created_at=item.created_at,
                ),
            )
        )

    # 2) Item comments.
    comment_rows = (
        await db.execute(
            select(WorkspaceItemComment, WorkspaceItem, User)
            .join(
                WorkspaceItem,
                WorkspaceItem.id == WorkspaceItemComment.item_id,
            )
            .outerjoin(User, User.id == WorkspaceItemComment.author_user_id)
            .where(
                WorkspaceItemComment.workspace_id == workspace_id, visible
            )
            .order_by(WorkspaceItemComment.created_at.desc())
            .limit(limit)
        )
    ).all()
    for c, item, author in comment_rows:
        events.append(
            (
                c.created_at,
                ActivityEvent(
                    kind="item_comment",
                    actor=actor_of(author),
                    item_id=item.id,
                    item_kind=item.kind,
                    item_title=item.title,
                    text=c.body[:140],
                    created_at=c.created_at,
                ),
            )
        )

    # 3) Card comments + system activity ("moved to Done", "assigned to…").
    card_rows = (
        await db.execute(
            select(WorkspaceTaskComment, WorkspaceTask, User)
            .join(
                WorkspaceTask,
                WorkspaceTask.id == WorkspaceTaskComment.task_id,
            )
            .outerjoin(
                User, User.id == WorkspaceTaskComment.author_user_id
            )
            .where(WorkspaceTask.workspace_id == workspace_id)
            .order_by(WorkspaceTaskComment.created_at.desc())
            .limit(limit)
        )
    ).all()
    for c, task, author in card_rows:
        events.append(
            (
                c.created_at,
                ActivityEvent(
                    kind=(
                        "card_activity"
                        if c.kind == "activity"
                        else "card_comment"
                    ),
                    actor=actor_of(author),
                    item_id=task.board_item_id,
                    item_kind="board",
                    item_title=task.title,
                    text=c.text[:140],
                    created_at=c.created_at,
                ),
            )
        )

    events.sort(key=lambda pair: pair[0], reverse=True)
    return ActivityResponse(events=[e for _, e in events[:limit]])


__all__ = ["router"]

"""``query_board_cards`` — structured queries over a workspace board's cards
(Track 1 P4).

Boards are flattened to text for the chat's context, so "how many cards are
overdue for Jane" was prose inference over a dump — unreliable and it breaks
past the full-dump cap. This tool runs the question as a real query over the
``WorkspaceTask`` rows (status, assignee, priority, label, due date) and
returns an accurate count plus the matching cards.

Category ``"workspace"`` — advertised only in workspace chats with Tools on.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select

from app.auth.models import User
from app.chat.models import Conversation, WorkspaceItem, WorkspaceTask
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("promptly.chat.tools.query_board")

# Map the words people say to the canonical kanban status keys. Anything
# not in here is matched against the stored status verbatim (custom columns).
_STATUS_ALIASES = {
    "todo": "todo", "to do": "todo", "to-do": "todo", "backlog": "todo",
    "not started": "todo", "open": "todo",
    "doing": "doing", "in progress": "doing", "in-progress": "doing",
    "wip": "doing", "started": "doing", "active": "doing",
    "done": "done", "complete": "done", "completed": "done", "finished": "done",
}
_PRIORITIES = ("low", "medium", "high")
_DUE_MODES = ("overdue", "upcoming", "has_due", "no_due")
_MAX_LIST = 50


async def _resolve_board(
    db: Any, workspace_id: uuid.UUID, user_id: uuid.UUID, title: str | None
) -> tuple[WorkspaceItem | None, str | None]:
    """Return (board_item, error). Picks the named board, or the sole board
    when none is named. Mirrors the map's visibility rules."""
    q = (
        select(WorkspaceItem)
        .where(
            WorkspaceItem.workspace_id == workspace_id,
            WorkspaceItem.kind == "board",
            WorkspaceItem.archived_at.is_(None),
            WorkspaceItem.trashed_at.is_(None),
            or_(
                WorkspaceItem.visibility != "private",
                WorkspaceItem.created_by == user_id,
            ),
        )
        .order_by(WorkspaceItem.position.asc())
    )
    if title:
        t = title.strip().lower()
        exact = (
            await db.execute(q.where(func.lower(WorkspaceItem.title) == t))
        ).scalars().all()
        if exact:
            return exact[0], None
        like = (
            await db.execute(q.where(func.lower(WorkspaceItem.title).like(f"%{t}%")))
        ).scalars().all()
        if len(like) == 1:
            return like[0], None
        if len(like) > 1:
            return None, f'Several boards match "{title}" — name it exactly.'
        return None, f'No board titled "{title}" in this workspace.'
    boards = (await db.execute(q)).scalars().all()
    if not boards:
        return None, "This workspace has no board yet."
    if len(boards) == 1:
        return boards[0], None
    names = ", ".join(f'"{b.title}"' for b in boards[:8])
    return None, (
        f"This workspace has several boards ({names}) — pass the 'board' "
        "argument to pick one."
    )


async def _resolve_assignee(
    db: Any, ctx: ToolContext, assignee: str
) -> tuple[str, uuid.UUID | None, str | None]:
    """Return (mode, user_id, error). mode ∈ {"id","null","err"}."""
    a = assignee.strip().lower()
    if a in ("me", "myself", "mine"):
        return "id", ctx.user.id, None
    if a in ("unassigned", "nobody", "no one", "noone", "none"):
        return "null", None, None
    users = (
        await db.execute(
            select(User).where(
                or_(func.lower(User.username) == a, func.lower(User.email) == a)
            )
        )
    ).scalars().all()
    if not users:
        users = (
            await db.execute(
                select(User).where(func.lower(User.username).like(f"%{a}%"))
            )
        ).scalars().all()
    if len(users) == 1:
        return "id", users[0].id, None
    if not users:
        return "err", None, f'No member matching "{assignee}".'
    return "err", None, f'"{assignee}" matches several people — use an exact username.'


class QueryBoardCardsTool(Tool):
    name = "query_board_cards"
    category = "workspace"
    max_per_turn = 5
    timeout_seconds = 15.0
    max_content_chars = 8_000
    description = (
        "Query the cards on a workspace board with real filters instead of "
        "guessing from text — use this for anything countable or filterable: "
        "'how many cards are in progress', 'what's overdue for Jane', 'high "
        "priority cards', 'what's assigned to me', 'unassigned cards'. Returns "
        "an accurate count and the matching cards. Filters combine (AND)."
    )
    prompt_hint = (
        "query_board_cards — count/filter board cards by status, assignee, "
        "priority, label or due date (e.g. 'overdue for Jane')"
    )
    parameters = {
        "type": "object",
        "properties": {
            "board": {
                "type": "string",
                "description": (
                    "Board title. Optional — omit when the workspace has one "
                    "board; required to disambiguate when it has several."
                ),
            },
            "status": {
                "type": "string",
                "description": (
                    "Column/status to match, e.g. 'todo', 'in progress', "
                    "'done', or a custom column name."
                ),
            },
            "assignee": {
                "type": "string",
                "description": (
                    "A member's username, or 'me', or 'unassigned'."
                ),
            },
            "priority": {"type": "string", "enum": list(_PRIORITIES)},
            "label": {
                "type": "string",
                "description": "A label name defined on the board.",
            },
            "due": {
                "type": "string",
                "enum": list(_DUE_MODES),
                "description": (
                    "overdue = past due & not done; upcoming = due in the next "
                    "7 days; has_due / no_due = whether a due date is set."
                ),
            },
            "include_done": {
                "type": "boolean",
                "description": (
                    "Include completed cards. Defaults to false (open cards "
                    "only); implied true when status is 'done'."
                ),
            },
        },
        "required": [],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        conv = await ctx.db.get(Conversation, ctx.conversation_id)
        if conv is None or conv.workspace_id is None:
            raise ToolError("This chat isn't part of a workspace.")
        db = ctx.db

        board, err = await _resolve_board(
            db, conv.workspace_id, ctx.user.id, str(args.get("board") or "").strip() or None
        )
        if err:
            raise ToolError(err)
        assert board is not None

        conds: list[Any] = [WorkspaceTask.board_item_id == board.id]
        applied: list[str] = []
        include_done = bool(args.get("include_done"))

        status = str(args.get("status") or "").strip()
        if status:
            canon = _STATUS_ALIASES.get(status.lower(), status.lower())
            conds.append(func.lower(WorkspaceTask.status) == canon)
            applied.append(f"status={canon}")
            if canon == "done":
                include_done = True

        assignee = str(args.get("assignee") or "").strip()
        if assignee:
            mode, uid, aerr = await _resolve_assignee(db, ctx, assignee)
            if mode == "err":
                raise ToolError(aerr or "Couldn't resolve that assignee.")
            if mode == "null":
                conds.append(WorkspaceTask.assignee_user_id.is_(None))
                applied.append("assignee=unassigned")
            else:
                conds.append(WorkspaceTask.assignee_user_id == uid)
                applied.append(f"assignee={assignee}")

        priority = str(args.get("priority") or "").strip().lower()
        if priority in _PRIORITIES:
            conds.append(func.lower(WorkspaceTask.priority) == priority)
            applied.append(f"priority={priority}")

        label = str(args.get("label") or "").strip()
        if label:
            labels_cfg = (board.config or {}).get("labels") or []
            lid = next(
                (
                    str(l.get("id"))
                    for l in labels_cfg
                    if isinstance(l, dict)
                    and str(l.get("name", "")).strip().lower() == label.lower()
                ),
                None,
            )
            if lid is None:
                raise ToolError(f'No label named "{label}" on board "{board.title}".')
            conds.append(WorkspaceTask.labels.contains([lid]))
            applied.append(f"label={label}")

        now = datetime.now(timezone.utc)
        due = str(args.get("due") or "").strip().lower()
        if due == "overdue":
            conds.append(WorkspaceTask.due_at < now)
            conds.append(WorkspaceTask.done.is_(False))
            applied.append("overdue")
        elif due == "upcoming":
            conds.append(WorkspaceTask.due_at >= now)
            conds.append(WorkspaceTask.due_at < now + timedelta(days=7))
            applied.append("due in next 7 days")
        elif due == "has_due":
            conds.append(WorkspaceTask.due_at.is_not(None))
            applied.append("has a due date")
        elif due == "no_due":
            conds.append(WorkspaceTask.due_at.is_(None))
            applied.append("no due date")

        if not include_done:
            conds.append(WorkspaceTask.done.is_(False))

        count = (
            await db.execute(
                select(func.count()).select_from(WorkspaceTask).where(*conds)
            )
        ).scalar_one()

        rows = (
            await db.execute(
                select(WorkspaceTask)
                .where(*conds)
                .order_by(WorkspaceTask.due_at.asc(), WorkspaceTask.position.asc())
                .limit(_MAX_LIST)
            )
        ).scalars().all()

        # Resolve assignee display names for the shown cards in one query.
        aids = {r.assignee_user_id for r in rows if r.assignee_user_id}
        names: dict[uuid.UUID, str] = {}
        if aids:
            for u in (
                await db.execute(select(User).where(User.id.in_(aids)))
            ).scalars().all():
                names[u.id] = u.username

        filt = f" ({', '.join(applied)})" if applied else ""
        header = f'Board "{board.title}": {count} card(s) match{filt}.'
        lines = [header]
        for r in rows:
            bits = [r.status]
            if r.assignee_user_id:
                bits.append(names.get(r.assignee_user_id, "someone"))
            if r.due_at is not None:
                bits.append(f"due {r.due_at.date().isoformat()}")
            bits.append(r.priority)
            lines.append(f'- "{r.title}" · ' + " · ".join(bits))
        if count > len(rows):
            lines.append(f"…and {count - len(rows)} more (showing first {_MAX_LIST}).")

        return ToolResult(
            content="\n".join(lines),
            meta={
                "board": board.title,
                "count": int(count),
                "filters": applied,
                # Item-link pill the UI renders under the tool card — opens
                # the board in the workspace preview modal.
                "items": [
                    {
                        "id": str(board.id),
                        "kind": "board",
                        "ref_id": str(board.ref_id) if board.ref_id else None,
                        "title": board.title,
                        "workspace_id": str(conv.workspace_id),
                    }
                ],
            },
        )

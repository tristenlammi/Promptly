"""Workspace write-back *proposal* tools (Batch 4.1).

The S-tier unlock: a workspace chat can turn its conversation into
workspace content — but never by writing directly. Each tool files a
``WorkspaceProposal`` row and the user applies or dismisses it from a
preview card in the chat. Two operations ship in v1, both create-only:

* ``propose_workspace_note``  — a new note from Markdown.
* ``propose_board_cards``     — cards on the workspace's board.

(Editing/appending existing notes needs server-side CRDT merging into
the live Y.Doc — deferred; see the tracker.)

Only offered in workspace chats (category ``"workspace"`` is enabled by
the router when ``conversation.workspace_id`` is set).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select

from app.chat.models import (
    Conversation,
    WorkspaceItem,
    WorkspaceProposal,
    WorkspaceTask,
)
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("promptly.chat.tools.workspace")

_MAX_NOTE_CHARS = 40_000
_MAX_CARDS = 10
# Bulk edits touch existing rows — allow a bigger batch than card creation
# (a "mark every in-progress card done" can legitimately span a column).
_MAX_UPDATE = 50
_PRIORITIES = ("low", "medium", "high")
_DUE_MODES = ("overdue", "upcoming", "has_due", "no_due")


async def _workspace_id_for(ctx: ToolContext) -> uuid.UUID:
    conv = await ctx.db.get(Conversation, ctx.conversation_id)
    if conv is None or conv.workspace_id is None:
        # Shouldn't happen (category gating), but the model can retry
        # tools across regenerations — fail with a readable reason.
        raise ToolError("This chat isn't part of a workspace.")
    return conv.workspace_id


def _board_pill(board: WorkspaceItem, workspace_id: uuid.UUID) -> dict[str, Any]:
    """The item-link pill the chat UI renders under the tool card — clicking
    it opens the board in the workspace preview modal."""
    return {
        "id": str(board.id),
        "kind": "board",
        "ref_id": str(board.ref_id) if board.ref_id else None,
        "title": board.title,
        "workspace_id": str(workspace_id),
    }


class ProposeWorkspaceNoteTool(Tool):
    name = "propose_workspace_note"
    category = "workspace"
    max_per_turn = 3
    # Pure DB write — anything past 30s means the pool is wedged.
    timeout_seconds = 30.0
    description = (
        "Propose creating a new note in this chat's workspace from Markdown "
        "content. Use when the user asks to save, capture, or turn the "
        "discussion into a note/brief/summary document. The note is NOT "
        "created immediately — the user sees a preview card and must "
        "approve it, so never claim the note already exists."
    )
    prompt_hint = (
        "propose_workspace_note — draft a workspace note from this chat "
        "(the user approves it from a preview card before anything is created)"
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "maxLength": 200,
                "description": "Note title.",
            },
            "markdown": {
                "type": "string",
                "description": "Full note body as Markdown.",
            },
        },
        "required": ["title", "markdown"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        markdown = str(args.get("markdown") or "").strip()
        if not title or not markdown:
            raise ToolError("Both a title and Markdown content are required.")
        if len(markdown) > _MAX_NOTE_CHARS:
            raise ToolError(
                f"Note content is capped at {_MAX_NOTE_CHARS} characters — "
                "shorten it or split into two notes."
            )
        workspace_id = await _workspace_id_for(ctx)
        proposal = WorkspaceProposal(
            conversation_id=ctx.conversation_id,
            workspace_id=workspace_id,
            user_id=ctx.user.id,
            kind="create_note",
            payload={"title": title[:200], "markdown": markdown},
        )
        ctx.db.add(proposal)
        await ctx.db.commit()
        return ToolResult(
            content=(
                f'Proposal filed: create note "{title}" '
                f"({len(markdown)} chars). A preview card is now showing in "
                "the chat — tell the user to review and Apply it. The note "
                "does not exist yet."
            ),
            meta={
                "proposal_id": str(proposal.id),
                "kind": "create_note",
                "title": title,
            },
        )


class ProposeBoardCardsTool(Tool):
    name = "propose_board_cards"
    category = "workspace"
    max_per_turn = 3
    # Pure DB write — anything past 30s means the pool is wedged.
    timeout_seconds = 30.0
    description = (
        "Propose adding NEW task cards to this workspace's board. Use when the "
        "user asks to capture action items, to-dos, or next steps as board "
        "cards. Cards are NOT created immediately — the user approves them "
        "from a preview card, so never claim they already exist. To CHANGE "
        "existing cards (mark done, move column, priority, due date), use "
        "propose_board_updates instead — do NOT re-add them as new cards."
    )
    prompt_hint = (
        "propose_board_cards — turn action items into board cards "
        "(user-approved before anything is created)"
    )
    parameters = {
        "type": "object",
        "properties": {
            "board": {
                "type": "string",
                "description": (
                    "Board title. Optional — omit when the workspace has one "
                    "board; required to pick when it has several."
                ),
            },
            "cards": {
                "type": "array",
                "minItems": 1,
                "maxItems": _MAX_CARDS,
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "maxLength": 200},
                        "description": {"type": "string", "maxLength": 2000},
                        "priority": {
                            "type": "string",
                            "enum": list(_PRIORITIES),
                        },
                        "due_date": {
                            "type": "string",
                            "description": "YYYY-MM-DD (optional)",
                        },
                    },
                    "required": ["title"],
                },
            },
        },
        "required": ["cards"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        raw_cards = args.get("cards")
        if not isinstance(raw_cards, list) or not raw_cards:
            raise ToolError("Provide at least one card with a title.")
        if len(raw_cards) > _MAX_CARDS:
            raise ToolError(f"At most {_MAX_CARDS} cards per proposal.")

        workspace_id = await _workspace_id_for(ctx)
        # Resolve the target board now (by the given title, or the sole
        # board) so a missing/ambiguous board fails loudly at propose time,
        # not at apply time — and so we add to the board the user meant, not
        # just whichever sorts first. Shares the resolver with the read tool.
        from app.chat.tools.query_board import _resolve_board

        board, berr = await _resolve_board(
            ctx.db,
            workspace_id,
            ctx.user.id,
            str(args.get("board") or "").strip() or None,
        )
        if berr:
            raise ToolError(berr)
        assert board is not None

        cards: list[dict[str, Any]] = []
        for raw in raw_cards:
            if not isinstance(raw, dict):
                continue
            title = str(raw.get("title") or "").strip()
            if not title:
                continue
            card: dict[str, Any] = {"title": title[:200]}
            desc = str(raw.get("description") or "").strip()
            if desc:
                card["description"] = desc[:2000]
            prio = str(raw.get("priority") or "").strip().lower()
            if prio in _PRIORITIES:
                card["priority"] = prio
            due = str(raw.get("due_date") or "").strip()
            if due:
                card["due_date"] = due[:10]
            cards.append(card)
        if not cards:
            raise ToolError("No valid cards — each needs a non-empty title.")

        proposal = WorkspaceProposal(
            conversation_id=ctx.conversation_id,
            workspace_id=workspace_id,
            user_id=ctx.user.id,
            kind="add_cards",
            payload={
                "board_item_id": str(board.id),
                "board_title": board.title,
                "cards": cards,
            },
        )
        ctx.db.add(proposal)
        await ctx.db.commit()
        titles = ", ".join(f'"{c["title"]}"' for c in cards[:3])
        more = f" (+{len(cards) - 3} more)" if len(cards) > 3 else ""
        return ToolResult(
            content=(
                f"Proposal filed: {len(cards)} card(s) for board "
                f'"{board.title}": {titles}{more}. A preview card is now '
                "showing in the chat — tell the user to review and Apply. "
                "The cards do not exist yet."
            ),
            meta={
                "proposal_id": str(proposal.id),
                "kind": "add_cards",
                "count": len(cards),
                "items": [_board_pill(board, workspace_id)],
            },
        )


class ProposeBoardUpdatesTool(Tool):
    name = "propose_board_updates"
    category = "workspace"
    max_per_turn = 3
    timeout_seconds = 30.0
    description = (
        "Propose changes to EXISTING cards on this workspace's board — move "
        "them to a different column/status (e.g. mark done), or change their "
        "priority or due date. Use for requests like 'mark the in-progress "
        "ones as done', 'move X to done', 'set these to high priority', or "
        "'clear the due dates'. Pick which cards with a filter "
        "(status / assignee / priority / due) or by exact titles, then give "
        "the change(s) in 'set'. Nothing changes until the user approves the "
        "preview card, so never claim the cards are already updated. To ADD "
        "new cards, use propose_board_cards instead."
    )
    prompt_hint = (
        "propose_board_updates — change existing board cards (status / "
        "priority / due), e.g. mark the in-progress cards done (user-approved)"
    )
    parameters = {
        "type": "object",
        "properties": {
            "board": {
                "type": "string",
                "description": (
                    "Board title. Optional when the workspace has one board."
                ),
            },
            "match": {
                "type": "object",
                "description": (
                    "Which cards to change — filters combine (AND). Give at "
                    "least one of status / assignee / priority / due / titles."
                ),
                "properties": {
                    "status": {
                        "type": "string",
                        "description": (
                            "Current column/status, e.g. 'in progress', "
                            "'todo', 'done', or a custom column name."
                        ),
                    },
                    "assignee": {
                        "type": "string",
                        "description": "A member username, or 'me', or 'unassigned'.",
                    },
                    "priority": {"type": "string", "enum": list(_PRIORITIES)},
                    "due": {"type": "string", "enum": list(_DUE_MODES)},
                    "titles": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Exact card titles to change.",
                    },
                },
            },
            "set": {
                "type": "object",
                "description": (
                    "The change(s) to apply to every matched card. Give at "
                    "least one."
                ),
                "properties": {
                    "status": {
                        "type": "string",
                        "description": (
                            "Move to this column/status, e.g. 'done', "
                            "'in progress', 'todo'."
                        ),
                    },
                    "priority": {"type": "string", "enum": list(_PRIORITIES)},
                    "due_date": {
                        "type": "string",
                        "description": "New due date, YYYY-MM-DD.",
                    },
                    "clear_due": {
                        "type": "boolean",
                        "description": "Remove the due date.",
                    },
                },
            },
        },
        "required": ["match", "set"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.chat.tools.query_board import (
            _STATUS_ALIASES,
            _resolve_assignee,
            _resolve_board,
        )

        workspace_id = await _workspace_id_for(ctx)
        board, berr = await _resolve_board(
            ctx.db,
            workspace_id,
            ctx.user.id,
            str(args.get("board") or "").strip() or None,
        )
        if berr:
            raise ToolError(berr)
        assert board is not None

        match = args.get("match")
        set_ = args.get("set")
        if not isinstance(match, dict) or not isinstance(set_, dict):
            raise ToolError("`match` and `set` must both be objects.")

        # --- Build the change set first, so an empty `set` fails fast. ---
        changes: dict[str, Any] = {}
        set_status = str(set_.get("status") or "").strip()
        if set_status:
            changes["status"] = _STATUS_ALIASES.get(
                set_status.lower(), set_status.lower()
            )
        set_prio = str(set_.get("priority") or "").strip().lower()
        if set_prio in _PRIORITIES:
            changes["priority"] = set_prio
        if set_.get("clear_due"):
            changes["due_date"] = None  # explicit None = clear
        else:
            set_due = str(set_.get("due_date") or "").strip()
            if set_due:
                changes["due_date"] = set_due[:10]
        if not changes:
            raise ToolError(
                "Nothing to change — set a new status, priority, or due date."
            )

        # --- Build the card selection (mirrors query_board_cards). ---
        conds: list[Any] = [WorkspaceTask.board_item_id == board.id]
        applied: list[str] = []

        m_status = str(match.get("status") or "").strip()
        if m_status:
            canon = _STATUS_ALIASES.get(m_status.lower(), m_status.lower())
            conds.append(func.lower(WorkspaceTask.status) == canon)
            applied.append(f"status={canon}")

        m_assignee = str(match.get("assignee") or "").strip()
        if m_assignee:
            mode, uid, aerr = await _resolve_assignee(ctx.db, ctx, m_assignee)
            if mode == "err":
                raise ToolError(aerr or "Couldn't resolve that assignee.")
            if mode == "null":
                conds.append(WorkspaceTask.assignee_user_id.is_(None))
                applied.append("unassigned")
            else:
                conds.append(WorkspaceTask.assignee_user_id == uid)
                applied.append(f"assignee={m_assignee}")

        m_prio = str(match.get("priority") or "").strip().lower()
        if m_prio in _PRIORITIES:
            conds.append(func.lower(WorkspaceTask.priority) == m_prio)
            applied.append(f"priority={m_prio}")

        now = datetime.now(timezone.utc)
        m_due = str(match.get("due") or "").strip().lower()
        if m_due == "overdue":
            conds.append(WorkspaceTask.due_at < now)
            conds.append(WorkspaceTask.done.is_(False))
            applied.append("overdue")
        elif m_due == "upcoming":
            conds.append(WorkspaceTask.due_at >= now)
            conds.append(WorkspaceTask.due_at < now + timedelta(days=7))
            applied.append("due soon")
        elif m_due == "has_due":
            conds.append(WorkspaceTask.due_at.is_not(None))
        elif m_due == "no_due":
            conds.append(WorkspaceTask.due_at.is_(None))

        titles = match.get("titles")
        if isinstance(titles, list) and titles:
            wanted = [
                str(t).strip().lower() for t in titles if str(t).strip()
            ]
            if wanted:
                conds.append(func.lower(WorkspaceTask.title).in_(wanted))
                applied.append(f"{len(wanted)} title(s)")

        if len(conds) == 1:
            raise ToolError(
                "Say which cards to change — a status / assignee / priority / "
                "due filter, or exact card titles."
            )

        rows = (
            await ctx.db.execute(
                select(WorkspaceTask)
                .where(*conds)
                .order_by(WorkspaceTask.position.asc())
                .limit(_MAX_UPDATE)
            )
        ).scalars().all()
        if not rows:
            raise ToolError(
                f'No cards on "{board.title}" match that filter — nothing was '
                "changed. Check the filter against the board."
            )

        snap = [{"id": str(t.id), "title": t.title} for t in rows]
        proposal = WorkspaceProposal(
            conversation_id=ctx.conversation_id,
            workspace_id=workspace_id,
            user_id=ctx.user.id,
            kind="update_cards",
            payload={
                "board_item_id": str(board.id),
                "board_title": board.title,
                "card_ids": [c["id"] for c in snap],
                "cards": snap,
                "changes": changes,
            },
        )
        ctx.db.add(proposal)
        await ctx.db.commit()

        change_bits: list[str] = []
        if "status" in changes:
            change_bits.append(f"move to {changes['status']}")
        if "priority" in changes:
            change_bits.append(f"priority → {changes['priority']}")
        if "due_date" in changes:
            change_bits.append(
                "clear due date"
                if changes["due_date"] is None
                else f"due {changes['due_date']}"
            )
        summary = "; ".join(change_bits)
        return ToolResult(
            content=(
                f'Proposal filed: update {len(rows)} card(s) on '
                f'"{board.title}" ({summary}). A preview card is now showing '
                "in the chat — tell the user to review and Apply. Nothing has "
                "changed yet."
            ),
            meta={
                "proposal_id": str(proposal.id),
                "kind": "update_cards",
                "count": len(rows),
                "items": [_board_pill(board, workspace_id)],
            },
        )

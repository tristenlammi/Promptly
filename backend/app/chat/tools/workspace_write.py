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
from typing import Any

from sqlalchemy import select

from app.chat.models import Conversation, WorkspaceItem, WorkspaceProposal
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("promptly.chat.tools.workspace")

_MAX_NOTE_CHARS = 40_000
_MAX_CARDS = 10
_PRIORITIES = ("low", "medium", "high")


async def _workspace_id_for(ctx: ToolContext) -> uuid.UUID:
    conv = await ctx.db.get(Conversation, ctx.conversation_id)
    if conv is None or conv.workspace_id is None:
        # Shouldn't happen (category gating), but the model can retry
        # tools across regenerations — fail with a readable reason.
        raise ToolError("This chat isn't part of a workspace.")
    return conv.workspace_id


class ProposeWorkspaceNoteTool(Tool):
    name = "propose_workspace_note"
    category = "workspace"
    max_per_turn = 3
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
    description = (
        "Propose adding task cards to this workspace's board. Use when the "
        "user asks to capture action items, to-dos, or next steps as board "
        "cards. Cards are NOT created immediately — the user approves them "
        "from a preview card, so never claim they already exist."
    )
    prompt_hint = (
        "propose_board_cards — turn action items into board cards "
        "(user-approved before anything is created)"
    )
    parameters = {
        "type": "object",
        "properties": {
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
        # Resolve the target board now so a missing board fails loudly at
        # propose time, not at apply time. Skip other people's private
        # boards — proposing onto something the approver can't see would
        # be baffling.
        board = (
            await ctx.db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == workspace_id,
                    WorkspaceItem.kind == "board",
                    WorkspaceItem.archived_at.is_(None),
                    (WorkspaceItem.visibility != "private")
                    | (WorkspaceItem.created_by == ctx.user.id),
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars().first()
        if board is None:
            raise ToolError(
                "This workspace has no board yet. Suggest the user create "
                "one first (+ New → New board), or propose a note instead."
            )

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
            },
        )

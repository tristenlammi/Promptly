"""``read_workspace_item`` — pull the full content of a workspace item on
demand (Track 1 P3).

The workspace map (always injected) tells the chat *what exists*; the
authored-item full-dump is capped, so a long note or a board past the cap
is only summarised or omitted. This tool lets the model fetch the complete,
live content of a specific note/board/sheet/canvas by title when it needs
more than was injected — the read half of "ask instead of file".

Category ``"workspace"`` — advertised only in workspace chats with Tools
on, the same gating as the write-proposal tools.
"""
from __future__ import annotations

import logging
from typing import Any

from app.chat.models import Conversation
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("promptly.chat.tools.read_workspace_item")

_READABLE_KINDS = ("note", "board", "sheet", "canvas")


class ReadWorkspaceItemTool(Tool):
    name = "read_workspace_item"
    category = "workspace"
    # A handful of reads per turn is plenty; caps a loop that keeps
    # re-opening the same item.
    max_per_turn = 5
    timeout_seconds = 15.0
    # A long note is legitimately large; cap so one giant item can't
    # dominate every subsequent hop's re-fed context.
    max_content_chars = 20_000
    description = (
        "Read the FULL current content of a note, board, sheet, or canvas in "
        "this chat's workspace, by its title exactly as it appears in the "
        "workspace map. Use this when an item exists (it's in the map or was "
        "mentioned above) but its full text wasn't included — e.g. the user "
        "asks about a specific note or board that was omitted or only "
        "summarised for length. Returns the item's live content."
    )
    prompt_hint = (
        "read_workspace_item — open a note/board/sheet/canvas by title to "
        "read its full current content when it wasn't fully included above"
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "maxLength": 200,
                "description": (
                    "The item's title, exactly as shown in the workspace map."
                ),
            },
            "kind": {
                "type": "string",
                "enum": list(_READABLE_KINDS),
                "description": (
                    "Optional — narrow to a kind when two items share a title."
                ),
            },
        },
        "required": ["title"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        if not title:
            raise ToolError(
                "Provide the item's title (as shown in the workspace map)."
            )
        kind = str(args.get("kind") or "").strip().lower() or None
        if kind is not None and kind not in _READABLE_KINDS:
            # Ignore an unrecognised kind rather than guaranteeing a 0-match.
            kind = None

        conv = await ctx.db.get(Conversation, ctx.conversation_id)
        if conv is None or conv.workspace_id is None:
            raise ToolError("This chat isn't part of a workspace.")

        # Lazy import: workspaces.knowledge pulls in a lot; importing at call
        # time keeps the tool-registry import graph light and acyclic.
        from app.workspaces.knowledge import read_workspace_item_text

        result = await read_workspace_item_text(
            ctx.db,
            workspace_id=conv.workspace_id,
            user_id=ctx.user.id,
            title=title,
            kind=kind,
        )
        if result is None:
            raise ToolError(
                f'No note, board, sheet, or canvas titled "{title}" is visible '
                "in this workspace. Check the workspace map for the exact title."
            )
        resolved_title, resolved_kind, text = result
        if not text:
            return ToolResult(
                content=f'"{resolved_title}" ({resolved_kind}) is currently empty.',
                meta={"title": resolved_title, "kind": resolved_kind, "chars": 0},
            )
        return ToolResult(
            content=f'Full content of {resolved_kind} "{resolved_title}":\n\n{text}',
            meta={
                "title": resolved_title,
                "kind": resolved_kind,
                "chars": len(text),
            },
        )

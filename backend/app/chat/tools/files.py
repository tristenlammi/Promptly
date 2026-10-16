"""Drive tools for any chat (WP-5.3): find, open and organise your files.

* ``list_my_files`` — files matching filters (type, folder, owner, dates,
  part of the name), with ids, plus the folders inside a folder.
* ``read_file`` — one file's text (Docs, Sheets with row numbers, PDFs with
  page breaks, Office and text files), capped, with paging.
* ``propose_file_changes`` — moves, renames and new folders, filed as a
  proposal the person applies from a preview card. Nothing moves until they
  do ("Organise my files").

Category ``files``: offered with the Tools toggle, in any chat (unlike the
workspace tools). The search *inside* files is ``search_my_files``, which
needs the opt-in AI search index; these don't — they read on demand what
the person asks about, under the same read rule as downloads.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from app.chat.models import WorkspaceProposal
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.chat.tools.validation import clean_model_text

logger = logging.getLogger("promptly.tools.files")

_READ_CAP = 24_000
_FILTER_PROPS: dict[str, Any] = {
    "type": {
        "type": "string",
        "enum": ["document", "sheet", "whiteboard", "pdf", "office", "image", "text", "audio", "video"],
    },
    "folder": {"type": "string", "description": "Path ('Taxes/2025'), name or id; includes subfolders."},
    "owner": {"type": "string", "description": "'me', 'shared', or a username/email."},
    "modified_after": {"type": "string", "description": "YYYY-MM-DD"},
    "modified_before": {"type": "string", "description": "YYYY-MM-DD"},
}


def _filter_error(exc: Exception) -> ToolError:
    return ToolError(str(exc))


class ListMyFilesTool(Tool):
    name = "list_my_files"
    category = "files"
    max_per_turn = 6
    timeout_seconds = 20.0
    description = (
        "List the user's files (own and shared), newest first, with ids, by type, folder, "
        "owner, date or name; also the folders at that level."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            **_FILTER_PROPS,
            "name": {"type": "string", "description": "Part of the name."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        },
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.files.finder import FilterError, build_filters, folder_path, list_files
        from app.files.models import FileFolder

        limit = args.get("limit", 30)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50:
            raise ToolError("`limit` must be an integer between 1 and 50.")
        try:
            filters = await build_filters(ctx.db, ctx.user.id, args)
        except FilterError as exc:
            raise _filter_error(exc) from exc
        rows, total = await list_files(ctx.db, ctx.user.id, filters, limit=limit)
        lines: list[str] = []
        label = f" ({', '.join(filters.labels)})" if filters.labels else ""
        if rows:
            more = f", showing the newest {len(rows)}" if total > len(rows) else ""
            lines.append(f"{total} file{'s' if total != 1 else ''}{label}{more}:")
            for r in rows:
                where = r["folder"] or "My files"
                lines.append(
                    f"- {clean_model_text(r['name'])} — {r['kind']}, in {clean_model_text(where)}, "
                    f"owner {r['owner']}, changed {r['modified']} (id: {r['id']})"
                )
        else:
            lines.append(f"No files match{label}.")

        # The folders at that level, so the model can see the structure it's
        # organising (own folders only — those are the ones it can change).
        from sqlalchemy import select

        parent = filters.folder_id
        sub = (
            await ctx.db.execute(
                select(FileFolder).where(
                    FileFolder.user_id == ctx.user.id,
                    FileFolder.trashed_at.is_(None),
                    FileFolder.parent_id == parent if parent is not None else FileFolder.parent_id.is_(None),
                ).order_by(FileFolder.name).limit(60)
            )
        ).scalars().all()
        if sub and (parent is not None or filters.is_empty() or filters.owner == "me"):
            base = await folder_path(ctx.db, await ctx.db.get(FileFolder, parent)) if parent else ""
            lines.append("")
            lines.append(f"Folders in {base or 'My files'}:")
            for f in sub:
                system = " (system folder — can't be renamed or moved)" if f.system_kind else ""
                lines.append(f"- {clean_model_text(f.name)}/ (id: {f.id}){system}")
        return ToolResult(content="\n".join(lines), meta={"result_count": len(rows), "total": total})


class ReadFileTool(Tool):
    name = "read_file"
    category = "files"
    max_per_turn = 6
    timeout_seconds = 30.0
    description = (
        "Read a file's text by id (docs, sheets with row numbers, PDFs, Office, text). Long "
        "files come in parts: call again with `start`."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "file_id": {"type": "string"},
            "start": {"type": "integer", "minimum": 0},
        },
        "required": ["file_id"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.files.access import can_read
        from app.files.drive_index import file_text_for
        from app.files.finder import folder_path, kind_label
        from app.files.models import FileFolder, UserFile

        try:
            fid = uuid.UUID(str(args.get("file_id") or ""))
        except ValueError as exc:
            raise ToolError("`file_id` must be a file id (from list_my_files or search_my_files).") from exc
        start = args.get("start", 0)
        if not isinstance(start, int) or isinstance(start, bool) or start < 0:
            raise ToolError("`start` must be a non-negative integer.")
        row = await ctx.db.get(UserFile, fid)
        if row is None or not await can_read(ctx.db, fid, ctx.user.id):
            raise ToolError("No file with that id that the user can open.")
        kind = kind_label(row.source_kind, row.mime_type, row.filename)
        if kind in ("image", "audio", "video"):
            raise ToolError(
                f"{row.filename} is {'an' if kind in ('image', 'audio') else 'a'} {kind} file — read_file only "
                "reads text. Ask the user to attach it to the chat instead."
            )
        try:
            body = await file_text_for(ctx.db, row)
        except Exception as exc:  # noqa: BLE001 — a broken file is a readable failure
            logger.info("read_file couldn't read %s", fid, exc_info=True)
            raise ToolError(f"Couldn't read {row.filename}.") from exc
        if not body:
            raise ToolError(f"{row.filename} has no text to read (it may be empty, scanned, or still being processed).")
        total = len(body)
        if start >= total:
            raise ToolError(f"`start` is past the end — the file has {total} characters.")
        part = body[start:start + _READ_CAP]
        end = start + len(part)
        folder = await ctx.db.get(FileFolder, row.folder_id) if row.folder_id else None
        where = await folder_path(ctx.db, folder) if row.user_id == ctx.user.id else "shared with you"
        head = (
            f"{row.filename} — {kind}, in {where or 'My files'}, changed "
            f"{row.modified_at.date().isoformat() if row.modified_at else 'unknown'} (id: {row.id})"
        )
        tail = (
            f"\n\n[Characters {start}–{end} of {total}. Call read_file with start={end} for the rest.]"
            if end < total else ""
        )
        source = {
            "title": clean_model_text(row.filename).strip(),
            "url": f"/files/f/{row.id}",
            "snippet": clean_model_text(part[:200]).strip(),
            "kind": "file",
            "file_id": str(row.id),
        }
        return ToolResult(
            content=f"{head}\n\n{clean_model_text(part)}{tail}",
            sources=[source],
            meta={"file_id": str(row.id), "chars": len(part), "total_chars": total},
        )


class ProposeFileChangesTool(Tool):
    name = "propose_file_changes"
    category = "files"
    max_per_turn = 3
    timeout_seconds = 30.0
    description = (
        "Propose new folders, moves and renames of the user's own files; they apply it from a "
        "preview card. `to` is a folder path ('' = My files); missing folders are created."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "operations": {
                "type": "array",
                "minItems": 1,
                "maxItems": 50,
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {"type": "string", "enum": ["create_folder", "move", "rename"]},
                        "path": {"type": "string"},
                        "item_type": {"type": "string", "enum": ["file", "folder"]},
                        "item_id": {"type": "string"},
                        "to": {"type": "string"},
                        "name": {"type": "string"},
                    },
                    "required": ["op"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["operations"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.files.organize import OrganizeError, check

        try:
            payload = await check(ctx.db, ctx.user, args.get("operations") or [])
        except OrganizeError as exc:
            raise ToolError(str(exc)) from exc
        proposal = WorkspaceProposal(
            conversation_id=ctx.conversation_id,
            workspace_id=None,
            user_id=ctx.user.id,
            kind="file_changes",
            payload=payload,
        )
        ctx.db.add(proposal)
        await ctx.db.commit()
        return ToolResult(
            content=(
                f"Proposal filed: {payload['summary']}. A preview card is now showing in the chat "
                "— tell the user to review and Apply it. Nothing has been moved or renamed yet."
            ),
            meta={"proposal_id": str(proposal.id), "kind": "file_changes", "summary": payload["summary"]},
        )


__all__ = ["ListMyFilesTool", "ProposeFileChangesTool", "ReadFileTool"]

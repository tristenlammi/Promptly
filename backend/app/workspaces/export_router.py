"""Workspace export bundle + Markdown-zip import (S-tier 6.2).

**Export** — ``GET /api/workspaces/{wid}/export`` streams a zip a firm
could hand to a client or park in cold storage:

    manifest.json          workspace meta, member list, item inventory
    notes/<title>.md       every note, converted from its HTML blob
    boards/<title>.csv     one row per card (column, priority, due,
                           labels, assignee, checklist)
    sheets/<title>.csv     one CSV per sheet tab, rebuilt from the
                           Fortune-sheet cell grid
    canvases/<title>.excalidraw  the drawing (opens in Excalidraw), plus
    canvases/<title>.txt         its extracted text
    rosters/<title>.csv    one row per shift (date, person, times, hours)
    discussions/<title>.md every thread and message
    automations.json       the workspace's automations (prompt, schedule,
                           flow graph) — no credentials
    chats/<title>.md       conversation transcripts
    files/<filename>       pinned Drive files, raw bytes

The manifest lists every item with its notebook path, so the structure
survives. The download is a short-lived signed link the browser streams
itself (``POST /export-link``) — the old blob fetch held the whole zip in
memory and gave up after five minutes (R-188).

Owner-only: the bundle is total exfiltration by design, so the bar is
the same as deleting the workspace. Other people's private drafts and
private chats are excluded even from the owner's bundle (R-312). Every
export writes an audit row.

The bundle is a human-readable export, not a restorable backup — a full
restore is the instance backup (Admin → Backups). Importing a bundle
brings back its notes (with their notebooks) and nothing else.

**Import** — ``POST /api/workspaces/import`` accepts a zip of Markdown
files (an Obsidian vault, a Notion/Confluence Markdown export) and
builds a fresh workspace from it: top-level directories become
notebooks, deeper directories stay in the note title, ``.md`` files
become collaborative notes (full Y.Doc seed + RAG indexing). Everything
skipped is reported back by reason.
"""
from __future__ import annotations

import asyncio

import csv
import io
import json
import logging
import os
import posixpath
import re
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from app.files.disk_guard import require_disk_room
from app.auth.audit import record_event
from app.auth.deps import get_current_user
from app.auth.events import (
    EVENT_WORKSPACE_EXPORTED,
    EVENT_WORKSPACE_IMPORTED,
)
from app.auth.models import User
from app.chat.models import (
    Conversation,
    DiscussionMessage,
    DiscussionThread,
    Message,
    Roster,
    Spreadsheet,
    Workspace,
    WorkspaceCanvas,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceShare,
    WorkspaceTask,
)
from app.database import get_db
from app.files.models import UserFile

logger = logging.getLogger("promptly.workspaces.export")
from app.workspaces.visibility import conversation_visible_to
from app.chat.versioning import active_path

router = APIRouter()

# Import guardrails: a Markdown export is thousands of small text files
# at most — anything past these bounds is a mispackaged upload. The note
# cap was 400, which turned away an ordinary Notion workspace whole
# (R-315); the total-size guard is what really bounds the work.
_IMPORT_MAX_NOTES = 2000
_IMPORT_MAX_NOTE_BYTES = 2 * 1024 * 1024
_IMPORT_MAX_TOTAL_BYTES = 200 * 1024 * 1024
_MD_EXTS = {".md", ".markdown", ".txt"}

# Notion appends " <32-hex block id>" to every page and folder name
# ("Meeting notes 1a2b…f0.md") — noise in a title (R-315).
_NOTION_ID_RE = re.compile(r"\s+[0-9a-fA-F]{32}$")

# Why an archive entry wasn't imported — returned to the UI as
# ``skipped: {reason: count}`` instead of a bare number (R-315).
_SKIP_NOT_MARKDOWN = "Not Markdown (images, attachments, other files)"
_SKIP_TOO_LARGE = "Markdown file larger than 2 MB"
_SKIP_UNREADABLE = "Damaged entry in the zip (couldn't be read)"
# Our own export bundle is a readable export, not a backup: only its
# notes come back. Everything else is reported, never turned into notes
# (a chat transcript imported as a note was the R-327 bug).
_BUNDLE_SKIP_REASONS = {
    "chats": "Chat transcripts from a Promptly export (not re-imported)",
    "canvases": "Canvases from a Promptly export (not re-imported)",
    "boards": "Boards, sheets and rosters from a Promptly export (CSV, not re-imported)",
    "sheets": "Boards, sheets and rosters from a Promptly export (CSV, not re-imported)",
    "rosters": "Boards, sheets and rosters from a Promptly export (CSV, not re-imported)",
    "discussions": "Discussions from a Promptly export (not re-imported)",
    "files": "Pinned files from a Promptly export (upload them to Drive instead)",
    "automations.json": "Automations from a Promptly export (not re-imported)",
}
_SKIP_BUNDLE_OTHER = "Other files from a Promptly export (not re-imported)"
# A zip with a root manifest.json and any of these folders is one of our
# bundles even if the manifest's ``format`` is missing or unreadable.
_BUNDLE_MARKER_DIRS = {"chats", "canvases", "boards", "sheets"}


def _safe_name(title: str, used: set[str], ext: str) -> str:
    """Filesystem-safe, zip-unique file name for ``title``."""
    base = re.sub(r"[^\w\- .()\[\]]", "_", (title or "untitled").strip())
    base = base.strip(". ") or "untitled"
    base = base[:80]
    name = f"{base}{ext}"
    n = 2
    while name in used:
        name = f"{base} ({n}){ext}"
        n += 1
    used.add(name)
    return name


def _visible_items(items: list[WorkspaceItem], user_id) -> list[WorkspaceItem]:
    """Everything except *other people's* private drafts — those stay
    creator-only even in the owner's bundle — and trashed items (0138)."""
    return [
        i
        for i in items
        if i.trashed_at is None
        and (i.visibility != "private" or i.created_by == user_id)
    ]


# ---------------------------------------------------------------------
# Per-kind serialisers
# ---------------------------------------------------------------------
def _board_csv(
    tasks: list[WorkspaceTask],
    label_names: dict[str, str],
    member_names: dict[uuid.UUID, str],
    field_defs: list[dict[str, Any]] | None = None,
) -> str:
    field_defs = field_defs or []
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "Title", "Column", "Priority", "Due", "Assignee", "Labels",
            "Checklist", "Description", "Created", "Completed",
            # One trailing column per custom field (0138).
            *[str(f.get("name") or f.get("id") or "") for f in field_defs],
        ]
    )
    for t in sorted(tasks, key=lambda x: (x.status, x.position)):
        checklist = "; ".join(
            f"[{'x' if s.get('done') else ' '}] {s.get('text', '')}"
            for s in (t.subtasks or [])
        )
        labels = ", ".join(
            label_names.get(lid, lid) for lid in (t.labels or [])
        )
        values = t.fields or {}

        def _field_value(f: dict[str, Any]) -> str:
            raw = values.get(str(f.get("id")))
            if raw is None:
                return ""
            # Select fields store the option id; export the label.
            if f.get("type") == "select":
                for opt in f.get("options") or []:
                    if isinstance(opt, dict) and opt.get("id") == raw:
                        return str(opt.get("label") or raw)
            return str(raw)

        w.writerow(
            [
                t.title,
                t.status,
                t.priority,
                t.due_at.date().isoformat() if t.due_at else "",
                member_names.get(t.assignee_user_id, "") if t.assignee_user_id else "",
                labels,
                checklist,
                (t.description or "").strip(),
                t.created_at.date().isoformat() if t.created_at else "",
                t.completed_at.date().isoformat() if t.completed_at else "",
                *[_field_value(f) for f in field_defs],
            ]
        )
    return buf.getvalue()


def _sheet_csvs(data: Any) -> list[tuple[str, str]]:
    """Fortune-sheet workbook JSON → ``[(tab_name, csv_text)]``.

    Rebuilds each tab's dense grid from its sparse ``celldata`` list.
    Cells prefer the display string (``v.m``) over the raw value (``v.v``)
    so formulas export what the user saw, not the formula source.
    """
    out: list[tuple[str, str]] = []
    if not isinstance(data, list):
        return out
    for sheet in data:
        if not isinstance(sheet, dict):
            continue
        cells = sheet.get("celldata") or []
        grid: dict[tuple[int, int], str] = {}
        max_r = max_c = -1
        for cell in cells:
            try:
                r, c = int(cell["r"]), int(cell["c"])
            except (KeyError, TypeError, ValueError):
                continue
            v = cell.get("v")
            if isinstance(v, dict):
                text = v.get("m") if v.get("m") is not None else v.get("v")
            else:
                text = v
            if text is None:
                continue
            grid[(r, c)] = str(text)
            max_r, max_c = max(max_r, r), max(max_c, c)
        if max_r < 0:
            continue
        buf = io.StringIO()
        w = csv.writer(buf)
        for r in range(max_r + 1):
            w.writerow([grid.get((r, c), "") for c in range(max_c + 1)])
        out.append((str(sheet.get("name") or "Sheet"), buf.getvalue()))
    return out


def _chat_markdown(title: str, messages: list[Message]) -> str:
    lines = [f"# {title}", ""]
    for m in messages:
        content = (m.content or "").strip()
        if not content or m.role == "system":
            continue
        who = "User" if m.role == "user" else "Assistant"
        stamp = m.created_at.strftime("%Y-%m-%d %H:%M") if m.created_at else ""
        lines.append(f"### {who} — {stamp}")
        lines.append("")
        lines.append(content)
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------
def canvas_scene_json(yjs_update: bytes) -> str | None:
    """A canvas's Y.Doc → an ``.excalidraw`` file: its live elements and
    only the images they use."""
    from pycrdt import Doc, Map

    try:
        doc = Doc()
        doc.apply_update(bytes(yjs_update))
        elements = doc.get("elements", type=Map).to_py() or {}
        files = doc.get("files", type=Map).to_py() or {}
    except Exception:  # noqa: BLE001 — a damaged doc just isn't exported
        logger.warning("export: couldn't decode a canvas", exc_info=True)
        return None
    live = [
        e for e in elements.values()
        if isinstance(e, dict) and not e.get("isDeleted")
    ]
    if not live:
        return None
    used_files = {e.get("fileId") for e in live if e.get("fileId")}
    live.sort(key=lambda e: str(e.get("index") or ""))
    return json.dumps(
        {
            "type": "excalidraw",
            "version": 2,
            "source": "promptly",
            "elements": live,
            "appState": {"viewBackgroundColor": "#ffffff"},
            "files": {k: v for k, v in files.items() if k in used_files},
        }
    )


def _roster_csv(data: Any, names: dict[str, str]) -> str:
    """One row per shift. ``personId`` is a member's user id (or a guest
    name); tags resolve through the roster's own tag list."""
    data = data if isinstance(data, dict) else {}
    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    tag_names = {
        t.get("id"): t.get("name") or t.get("label") or t.get("id")
        for t in (settings.get("tags") or [])
        if isinstance(t, dict)
    }
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "person", "start", "end", "hours", "tags", "note", "published"])
    shifts = [x for x in (data.get("shifts") or []) if isinstance(x, dict)]
    shifts.sort(key=lambda x: (str(x.get("date") or ""), str(x.get("start") or "")))
    for sh in shifts:
        pid = str(sh.get("personId") or "")
        w.writerow([
            sh.get("date") or "",
            names.get(pid, pid),
            sh.get("start") or "",
            sh.get("end") or "",
            sh.get("hours") if sh.get("hours") is not None else "",
            "; ".join(str(tag_names.get(t, t)) for t in (sh.get("tags") or [])),
            sh.get("note") or "",
            "yes" if sh.get("published") else "",
        ])
    return buf.getvalue()


def _discussion_markdown(
    title: str,
    threads: list[DiscussionThread],
    messages: dict[uuid.UUID, list[DiscussionMessage]],
    names: dict[str, str],
) -> str:
    out = [f"# {title}", ""]
    for th in threads:
        out += [f"## {th.title}", ""]
        for m in messages.get(th.id, []):
            who = names.get(str(m.author_user_id), "Someone") if m.author_user_id else "Someone"
            when = m.created_at.strftime("%Y-%m-%d %H:%M") if m.created_at else ""
            out += [f"**{who}** · {when}", "", m.body.strip(), ""]
    return "\n".join(out).rstrip() + "\n"


def _item_paths(items: list[WorkspaceItem]) -> dict[uuid.UUID, str]:
    """``Notebook / Page`` path for each item, so the manifest keeps the
    tree's structure (it only had flat parent ids)."""
    by_id = {i.id: i for i in items}
    out: dict[uuid.UUID, str] = {}
    for i in items:
        parts, cur, seen = [], i, set()
        while cur is not None and cur.id not in seen:
            seen.add(cur.id)
            parts.append(cur.title or "Untitled")
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
        out[i.id] = " / ".join(reversed(parts))
    return out


_EXPORT_LINK_TTL_S = 300


def _export_signature(workspace_id: uuid.UUID, user_id: uuid.UUID, exp: int) -> str:
    import hashlib
    import hmac

    from app.config import get_settings

    msg = f"workspace-export:{workspace_id}:{user_id}:{exp}".encode()
    return hmac.new(get_settings().SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()


@router.post("/{workspace_id}/export-link")
async def export_link(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """A five-minute signed URL the browser downloads directly, streaming
    to disk — no bearer header needed, nothing held in page memory."""
    import time

    ws = await db.get(Workspace, workspace_id)
    if ws is None or ws.user_id != user.id or ws.trashed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    exp = int(time.time()) + _EXPORT_LINK_TTL_S
    sig = _export_signature(ws.id, user.id, exp)
    return {
        "url": f"/api/workspaces/{ws.id}/export/download?u={user.id}&exp={exp}&sig={sig}"
    }


@router.get("/{workspace_id}/export/download")
async def export_download(
    workspace_id: uuid.UUID,
    u: uuid.UUID,
    exp: int,
    sig: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    import hmac
    import time

    if exp < int(time.time()) or not hmac.compare_digest(
        sig, _export_signature(workspace_id, u, exp)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This download link has expired — start the export again.",
        )
    user = await db.get(User, u)
    if user is None or user.disabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
    return await _export_response(workspace_id, request, db, user)


@router.get("/{workspace_id}/export")
async def export_workspace(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    return await _export_response(workspace_id, request, db, user)


def _read_text(path) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        return ""


async def _export_response(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession,
    user: User,
) -> FileResponse:
    from app.files.documents_router import _html_to_markdown
    from app.files.storage import absolute_path
    from app.tasks.models import Task as AutomationTask
    from app.workspaces.knowledge import WORKSPACE_MEMORY_SOURCE_KIND

    ws = await db.get(Workspace, workspace_id)
    if ws is None or ws.user_id != user.id or ws.trashed_at is not None:
        # Owner only — same bar as delete. Members see a 404, not a 403,
        # to avoid confirming the workspace id.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    items = _visible_items(
        list(
            (
                await db.execute(
                    select(WorkspaceItem).where(
                        WorkspaceItem.workspace_id == ws.id
                    )
                )
            ).scalars()
        ),
        user.id,
    )
    items_by_id = {i.id: i for i in items}

    # Member usernames (assignee column + manifest).
    member_rows = (
        await db.execute(
            select(User.id, User.username)
            .join(WorkspaceShare, WorkspaceShare.invitee_user_id == User.id)
            .where(
                WorkspaceShare.workspace_id == ws.id,
                WorkspaceShare.status == "accepted",
            )
        )
    ).all()
    member_names: dict[uuid.UUID, str] = {uid: name for uid, name in member_rows}
    member_names[ws.user_id] = user.username

    names_by_str = {str(k): v for k, v in member_names.items()}
    counts = {
        "notes": 0, "boards": 0, "sheets": 0, "canvases": 0, "rosters": 0,
        "discussions": 0, "automations": 0, "chats": 0, "files": 0,
    }
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            used: dict[str, set[str]] = {k: set() for k in counts}
            # item id -> its file in the zip, for the manifest (and import).
            files_of: dict[uuid.UUID, str] = {}

            for item in items:
                if item.kind == "note" and item.ref_id is not None:
                    uf = await db.get(UserFile, item.ref_id)
                    if uf is None or uf.trashed_at is not None:
                        continue
                    # File I/O and conversion off the event loop (R-188).
                    try:
                        html = await asyncio.to_thread(
                            _read_text, absolute_path(uf.storage_path)
                        )
                    except ValueError:
                        html = ""
                    md = (
                        await asyncio.to_thread(_html_to_markdown, html)
                        if html
                        else ""
                    ) or (uf.content_text or "")
                    arc = "notes/" + _safe_name(item.title, used["notes"], ".md")
                    zf.writestr(arc, md)
                    files_of[item.id] = arc
                    counts["notes"] += 1
                elif item.kind == "board":
                    tasks = list(
                        (
                            await db.execute(
                                select(WorkspaceTask).where(
                                    WorkspaceTask.board_item_id == item.id
                                )
                            )
                        ).scalars()
                    )
                    label_names = {
                        l["id"]: l.get("name", l["id"])
                        for l in ((item.config or {}).get("labels") or [])
                        if isinstance(l, dict) and "id" in l
                    }
                    field_defs = [
                        f
                        for f in ((item.config or {}).get("fields") or [])
                        if isinstance(f, dict)
                    ]
                    zf.writestr(
                        "boards/" + _safe_name(item.title, used["boards"], ".csv"),
                        _board_csv(tasks, label_names, member_names, field_defs),
                    )
                    counts["boards"] += 1
                elif item.kind == "sheet" and item.ref_id is not None:
                    sheet = await db.get(Spreadsheet, item.ref_id)
                    if sheet is None:
                        continue
                    tabs = _sheet_csvs(sheet.data)
                    for tab_name, csv_text in tabs:
                        stem = (
                            item.title
                            if len(tabs) == 1
                            else f"{item.title} — {tab_name}"
                        )
                        zf.writestr(
                            "sheets/" + _safe_name(stem, used["sheets"], ".csv"),
                            csv_text,
                        )
                    counts["sheets"] += 1
                elif item.kind == "canvas" and item.ref_id is not None:
                    canvas = await db.get(WorkspaceCanvas, item.ref_id)
                    # The drawing itself, as a file Excalidraw (or
                    # excalidraw.com) opens — the bundle used to carry only
                    # the canvas's extracted text (R-175).
                    scene = (
                        await asyncio.to_thread(canvas_scene_json, canvas.yjs_update)
                        if canvas is not None and canvas.yjs_update
                        else None
                    )
                    if scene:
                        stem = _safe_name(item.title, used["canvases"], ".excalidraw")
                        zf.writestr("canvases/" + stem, scene)
                        files_of[item.id] = "canvases/" + stem
                    text = (canvas.content_text or "").strip() if canvas else ""
                    if text:
                        zf.writestr(
                            "canvases/"
                            + _safe_name(item.title, used["canvases"], ".txt"),
                            text,
                        )
                    counts["canvases"] += 1
                elif item.kind == "roster" and item.ref_id is not None:
                    roster = await db.get(Roster, item.ref_id)
                    if roster is None:
                        continue
                    zf.writestr(
                        "rosters/" + _safe_name(item.title, used["rosters"], ".csv"),
                        _roster_csv(roster.data, names_by_str),
                    )
                    counts["rosters"] += 1
                elif item.kind == "discussion":
                    threads = list(
                        (
                            await db.execute(
                                select(DiscussionThread)
                                .where(DiscussionThread.item_id == item.id)
                                .order_by(DiscussionThread.created_at.asc())
                            )
                        ).scalars()
                    )
                    msgs: dict[uuid.UUID, list[DiscussionMessage]] = {}
                    if threads:
                        for m in (
                            await db.execute(
                                select(DiscussionMessage)
                                .where(
                                    DiscussionMessage.thread_id.in_(
                                        [t.id for t in threads]
                                    )
                                )
                                .order_by(DiscussionMessage.created_at.asc())
                            )
                        ).scalars():
                            msgs.setdefault(m.thread_id, []).append(m)
                    zf.writestr(
                        "discussions/"
                        + _safe_name(item.title, used["discussions"], ".md"),
                        _discussion_markdown(item.title, threads, msgs, names_by_str),
                    )
                    counts["discussions"] += 1

            # Automations homed here — what they do and when, never their
            # credentials (those live in the vault, not on the task).
            autos = list(
                (
                    await db.execute(
                        select(AutomationTask).where(
                            AutomationTask.workspace_id == ws.id
                        )
                    )
                ).scalars()
            )
            if autos:
                zf.writestr(
                    "automations.json",
                    json.dumps(
                        [
                            {
                                "title": t.title,
                                "prompt": t.prompt,
                                "enabled": t.enabled,
                                "frequency": t.frequency,
                                "hour": t.hour,
                                "minute": t.minute,
                                "weekday": t.weekday,
                                "day_of_month": t.day_of_month,
                                "timezone": t.timezone,
                                "model_id": t.model_id,
                                "graph": t.flow_graph,
                                "owner": member_names.get(t.user_id),
                            }
                            for t in autos
                        ],
                        indent=2,
                        default=str,
                    ),
                )
                counts["automations"] = len(autos)

            # Chats — workspace conversations (tree chat pages point at the
            # same Conversation rows, so exporting by workspace covers both).
            convs = list(
                (
                    await db.execute(
                        select(Conversation).where(
                            Conversation.workspace_id == ws.id,
                            # The owner exports shared chats and their own —
                            # never another member's private chats.
                            conversation_visible_to(ws.user_id),
                        )
                    )
                ).scalars()
            )
            for conv in convs:
                rows = list(
                    (
                        await db.execute(
                            select(Message)
                            .where(Message.conversation_id == conv.id)
                            .order_by(Message.created_at.asc(), Message.id.asc())
                        )
                    ).scalars()
                )
                # Only the thread the user sees — not every regeneration
                # and edit sibling interleaved by timestamp (R-307).
                msgs = active_path(rows, conv.active_leaf_message_id)
                if not msgs:
                    continue
                title = conv.title or "Untitled chat"
                zf.writestr(
                    "chats/" + _safe_name(title, used["chats"], ".md"),
                    _chat_markdown(title, msgs),
                )
                counts["chats"] += 1

            # Pinned Drive files, raw. The hidden rolling-memory doc is
            # internal plumbing, not user content — skip it.
            pins = (
                await db.execute(
                    select(UserFile)
                    .join(WorkspaceFile, WorkspaceFile.file_id == UserFile.id)
                    .where(
                        WorkspaceFile.workspace_id == ws.id,
                        UserFile.trashed_at.is_(None),
                        UserFile.source_kind.is_distinct_from(
                            WORKSPACE_MEMORY_SOURCE_KIND
                        ),
                    )
                )
            ).scalars()
            for uf in pins:
                try:
                    path = absolute_path(uf.storage_path)
                    if not path.exists():
                        continue
                    # Deflating a pinned file (up to 100 MB) is CPU-bound —
                    # in a thread, so the export doesn't freeze every other
                    # user's chat (R-016). Writes stay sequential.
                    await asyncio.to_thread(
                        zf.write,
                        path,
                        "files/"
                        + _safe_name(
                            os.path.splitext(uf.filename or "file")[0],
                            used["files"],
                            os.path.splitext(uf.filename or "")[1],
                        ),
                    )
                    counts["files"] += 1
                except (OSError, ValueError):
                    logger.warning(
                        "export: skipping unreadable file %s", uf.id
                    )

            paths = _item_paths(items)
            manifest = {
                "format": "promptly-workspace-export",
                "version": 2,
                "workspace": {
                    "id": str(ws.id),
                    "title": ws.title,
                    "description": ws.description,
                    "created_at": ws.created_at.isoformat() if ws.created_at else None,
                },
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "exported_by": user.username,
                "members": sorted(member_names.values()),
                "counts": counts,
                "items": [
                    {
                        "id": str(i.id),
                        "kind": i.kind,
                        "title": i.title,
                        "parent_id": str(i.parent_id) if i.parent_id else None,
                        "path": paths.get(i.id),
                        "file": files_of.get(i.id),
                    }
                    for i in items
                ],
                "limitations": [
                    "This is a readable export, not a restorable backup. "
                    "Importing it brings back the notes only; a full "
                    "restore is the instance backup (Admin → Backups).",
                    "Chats are the exporter's own chats plus chats shared "
                    "with the workspace; other members' private chats and "
                    "private drafts are never included.",
                    "Chat transcripts hold the visible thread only, not "
                    "regenerated or edited alternatives.",
                    "Sheets here are display values (CSV); download a sheet "
                    "as .xlsx from the sheet itself to keep its formulas.",
                ],
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    await record_event(
        db,
        event_type=EVENT_WORKSPACE_EXPORTED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={ws.id}) — '
        + ", ".join(f"{v} {k}" for k, v in counts.items() if v),
    )
    await db.commit()

    fname = _safe_name(ws.title, set(), ".zip")
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=f"promptly-workspace-{fname}",
        background=BackgroundTask(os.unlink, tmp_path),
    )


# ---------------------------------------------------------------------
# Import (Markdown zip → new workspace)
# ---------------------------------------------------------------------
def _clean_segment(seg: str) -> str:
    """A path segment as a title: Notion's trailing block id removed."""
    cleaned = _NOTION_ID_RE.sub("", seg).strip()
    return cleaned or seg.strip()


def _note_target(
    path: str, meta: dict | None, bundle: bool
) -> tuple[str | None, str]:
    """``(notebook name or None, note title)`` for an archive path.

    An export bundle's manifest knows each note's real title and notebook.
    Otherwise the top-level directory becomes the notebook (notebooks
    don't nest, so one level) and any deeper directories stay in the
    title: ``Specs/2024/API.md`` → notebook "Specs", note "2024 / API".
    """
    if meta is not None:
        title = (meta.get("title") or "Untitled")[:200]
        crumbs = [c for c in str(meta.get("path") or "").split(" / ") if c]
        return (crumbs[0][:200] if len(crumbs) > 1 else None), title
    parts = path.split("/")
    if bundle and parts[0] == "notes" and len(parts) > 1:
        parts = parts[1:]
    *dirs, leaf = parts
    stem = _clean_segment(posixpath.splitext(leaf)[0]) or "Untitled"
    dirs = [d for d in (_clean_segment(d) for d in dirs) if d]
    if not dirs:
        return None, stem[:200]
    return dirs[0][:200], " / ".join([*dirs[1:], stem])[:200]


class _ImportPlan:
    """What an uploaded archive will turn into, worked out before any row
    is created."""

    def __init__(self) -> None:
        self.entries: list[tuple[str, zipfile.ZipInfo]] = []
        self.skipped: dict[str, int] = {}
        self.manifest: dict | None = None
        self.bundle = False

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1


def _scan_archive(zf: zipfile.ZipFile) -> _ImportPlan:
    """Sort an archive's entries into notes to import and skips by reason.

    Blocking (reads the manifest) — run it in a thread.
    """
    plan = _ImportPlan()
    cands: list[tuple[list[str], zipfile.ZipInfo]] = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        # Zips from macOS bundle metadata; Notion exports carry asset dirs.
        # Neither is the user's content, so they're dropped unreported.
        parts = [p for p in posixpath.normpath(info.filename).split("/") if p]
        if (
            not parts
            or any(p.startswith(("__MACOSX", ".")) for p in parts)
            or ".." in parts
        ):
            continue
        cands.append((parts, info))

    # A zip of a folder ("My Vault/…", Notion's "Export-<id>/…") wraps
    # everything in one root directory — that's the archive, not a
    # notebook, and a re-zipped export bundle hides its manifest under it.
    if (
        cands
        and all(len(p) > 1 for p, _ in cands)
        and len({p[0] for p, _ in cands}) == 1
    ):
        cands = [(p[1:], i) for p, i in cands]

    paths = {"/".join(p): i for p, i in cands}
    if "manifest.json" in paths:
        try:
            parsed = json.loads(
                zf.read(paths["manifest.json"]).decode("utf-8", errors="replace")
            )
        except (ValueError, zipfile.BadZipFile, OSError):
            parsed = None
        if (
            isinstance(parsed, dict)
            and parsed.get("format") == "promptly-workspace-export"
        ):
            plan.manifest = parsed
        top_dirs = {p[0] for p, _ in cands if len(p) > 1}
        plan.bundle = plan.manifest is not None or bool(
            top_dirs & _BUNDLE_MARKER_DIRS
        )

    for parts, info in cands:
        path = "/".join(parts)
        if plan.bundle:
            if path == "manifest.json":
                continue
            if parts[0] != "notes" or len(parts) == 1:
                plan.skip(_BUNDLE_SKIP_REASONS.get(parts[0], _SKIP_BUNDLE_OTHER))
                continue
        ext = posixpath.splitext(path)[1].lower()
        if ext not in _MD_EXTS:
            plan.skip(_SKIP_NOT_MARKDOWN)
            continue
        if info.file_size > _IMPORT_MAX_NOTE_BYTES:
            plan.skip(_SKIP_TOO_LARGE)
            continue
        plan.entries.append((path, info))
    return plan


def _read_and_render(zf: zipfile.ZipFile, info: zipfile.ZipInfo):
    """One archive entry → ``(markdown, rendered note)``. Blocking and CPU
    bound (zip inflate, Markdown → Y.Doc → HTML) — run it in a thread."""
    from app.workspaces.content_seed import render_note_markdown

    markdown = zf.read(info).decode("utf-8-sig", errors="replace")
    return markdown, render_note_markdown(markdown)


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_workspace(
    request: Request,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),  # WP-7.2
) -> dict:
    """Build a new workspace from a zip of Markdown files.

    Understands the folder layout of Obsidian vaults and Notion /
    Confluence Markdown exports: top-level directories become notebooks,
    ``.md`` files become collaborative notes (deeper directories stay in
    the note's title, Notion's block-id suffixes are stripped). A Promptly
    export bundle brings back its notes only. Every entry not imported is
    reported in ``skipped`` as ``{reason: count}``.

    Parsing and conversion run in worker threads; only the DB writes stay
    on the event loop (R-315).
    """
    from app.files.system_folders import create_workspace_folder_tree
    from app.workspaces.content_seed import (
        create_note_with_item,
        resolve_or_create_notebook,
    )
    from app.workspaces.knowledge import index_note_for_workspace

    try:
        zf = await asyncio.to_thread(zipfile.ZipFile, file.file)
        plan = await asyncio.to_thread(_scan_archive, zf)
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="That isn't a zip archive.",
        )

    entries = plan.entries
    if not entries:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="That export has no notes to import."
            if plan.bundle
            else "No Markdown files found in the archive.",
        )
    if len(entries) > _IMPORT_MAX_NOTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Imports are capped at {_IMPORT_MAX_NOTES} notes; "
            f"the archive holds {len(entries)}.",
        )
    total = sum(info.file_size for _, info in entries)
    if total > _IMPORT_MAX_TOTAL_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Imports are capped at "
            f"{_IMPORT_MAX_TOTAL_BYTES // (1024 * 1024)} MB of Markdown; "
            f"the archive holds {total // (1024 * 1024)} MB.",
        )

    # Our own export bundle: notes come back with their titles and
    # notebooks from the manifest (R-188).
    manifest = plan.manifest
    note_meta: dict[str, dict] = {}
    for it in (manifest or {}).get("items") or []:
        if isinstance(it, dict) and it.get("kind") == "note" and it.get("file"):
            note_meta[it["file"]] = it

    ws_title = (title or "").strip()[:100] or (
        (manifest or {}).get("workspace", {}).get("title")
        or _clean_segment(posixpath.splitext(file.filename or "")[0])
        or "Imported workspace"
    )[:100]
    ws = Workspace(user_id=user.id, title=ws_title)
    db.add(ws)
    await db.flush()
    ws_folder = await create_workspace_folder_tree(db, user, ws.title)
    ws.root_folder_id = ws_folder.id

    note_item_ids: list[uuid.UUID] = []
    # Notebooks created so far, by lower-cased title.
    notebooks: dict[str, uuid.UUID] = {}

    async def _notebook(name: str) -> uuid.UUID:
        key = name.strip().lower()
        if key not in notebooks:
            notebooks[key] = await resolve_or_create_notebook(
                db, ws=ws, creator_id=user.id, name=name
            )
        return notebooks[key]

    # New items land at the top of their list, so create Z→A to leave the
    # tree reading A→Z.
    for path, info in sorted(entries, key=lambda e: e[0], reverse=True):
        try:
            markdown, rendered = await asyncio.to_thread(
                _read_and_render, zf, info
            )
        except (zipfile.BadZipFile, OSError, EOFError):
            # A damaged member (bad CRC, truncated) — skip it, keep the rest.
            plan.skip(_SKIP_UNREADABLE)
            continue
        nb_name, note_title = _note_target(path, note_meta.get(path), plan.bundle)
        parent_id = (
            await _notebook(nb_name) if nb_name and nb_name.strip() else None
        )
        item = await create_note_with_item(
            db,
            ws=ws,
            owner=user,
            creator_id=user.id,
            title=note_title,
            markdown=markdown,
            parent_id=parent_id,
            rendered=rendered,
        )
        note_item_ids.append(item.id)

    skipped_total = sum(plan.skipped.values())
    await record_event(
        db,
        event_type=EVENT_WORKSPACE_IMPORTED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={ws.id}) — {len(note_item_ids)} note(s), '
        f"{len(notebooks)} notebook(s), {skipped_total} entr(ies) skipped",
    )
    await db.commit()

    # RAG-index the imported notes off-request; each call owns a session.
    for item_id in note_item_ids:
        background.add_task(index_note_for_workspace, ws.id, item_id)

    return {
        "id": str(ws.id),
        "title": ws.title,
        "notes": len(note_item_ids),
        "notebooks": len(notebooks),
        # {reason: count}, most common first — the UI lists these after
        # the import instead of discarding a bare number (R-315).
        "skipped": dict(sorted(plan.skipped.items(), key=lambda kv: -kv[1])),
        "skipped_total": skipped_total,
    }


__all__ = ["router"]

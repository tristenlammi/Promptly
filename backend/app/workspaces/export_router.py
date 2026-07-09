"""Workspace export bundle + Markdown-zip import (S-tier 6.2).

**Export** — ``GET /api/workspaces/{wid}/export`` streams a zip a firm
could hand to a client or park in cold storage:

    manifest.json          workspace meta, member list, item inventory
    notes/<title>.md       every note, converted from its HTML blob
    boards/<title>.csv     one row per card (column, priority, due,
                           labels, assignee, checklist)
    sheets/<title>.csv     one CSV per sheet tab, rebuilt from the
                           Fortune-sheet cell grid
    canvases/<title>.txt   the canvas's extracted text (the scene itself
                           is a collab CRDT the server can't render)
    chats/<title>.md       conversation transcripts
    files/<filename>       pinned Drive files, raw bytes

Owner-only: the bundle is total exfiltration by design, so the bar is
the same as deleting the workspace. Other people's private drafts are
excluded even from the owner's bundle. Every export writes an audit row.

**Import** — ``POST /api/workspaces/import`` accepts a zip of Markdown
files (an Obsidian vault, a Notion/Confluence Markdown export) and
builds a fresh workspace from it: directories become folders, ``.md``
files become collaborative notes (full Y.Doc seed + RAG indexing).
"""
from __future__ import annotations

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

from app.auth.audit import record_event
from app.auth.deps import get_current_user
from app.auth.events import (
    EVENT_WORKSPACE_EXPORTED,
    EVENT_WORKSPACE_IMPORTED,
)
from app.auth.models import User
from app.chat.models import (
    Conversation,
    Message,
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

router = APIRouter()

# Import guardrails: a Markdown export is thousands of small text files
# at most — anything past these bounds is a mispackaged upload.
_IMPORT_MAX_NOTES = 400
_IMPORT_MAX_NOTE_BYTES = 2 * 1024 * 1024
_MD_EXTS = {".md", ".markdown", ".txt"}


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
@router.get("/{workspace_id}/export")
async def export_workspace(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FileResponse:
    from app.files.documents_router import _html_to_markdown
    from app.files.storage import absolute_path
    from app.workspaces.knowledge import WORKSPACE_MEMORY_SOURCE_KIND

    ws = await db.get(Workspace, workspace_id)
    if ws is None or ws.user_id != user.id:
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

    counts = {"notes": 0, "boards": 0, "sheets": 0, "canvases": 0, "chats": 0, "files": 0}
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            used: dict[str, set[str]] = {
                "notes": set(), "boards": set(), "sheets": set(),
                "canvases": set(), "chats": set(), "files": set(),
            }

            for item in items:
                if item.kind == "note" and item.ref_id is not None:
                    uf = await db.get(UserFile, item.ref_id)
                    if uf is None or uf.trashed_at is not None:
                        continue
                    html = ""
                    try:
                        with open(absolute_path(uf.storage_path), encoding="utf-8") as f:
                            html = f.read()
                    except (OSError, ValueError):
                        pass
                    md = _html_to_markdown(html) or (uf.content_text or "")
                    zf.writestr(
                        "notes/" + _safe_name(item.title, used["notes"], ".md"),
                        md,
                    )
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
                    text = (canvas.content_text or "").strip() if canvas else ""
                    if text:
                        zf.writestr(
                            "canvases/"
                            + _safe_name(item.title, used["canvases"], ".txt"),
                            text,
                        )
                    counts["canvases"] += 1

            # Chats — workspace conversations (tree chat pages point at the
            # same Conversation rows, so exporting by workspace covers both).
            convs = list(
                (
                    await db.execute(
                        select(Conversation).where(
                            Conversation.workspace_id == ws.id
                        )
                    )
                ).scalars()
            )
            for conv in convs:
                msgs = list(
                    (
                        await db.execute(
                            select(Message)
                            .where(Message.conversation_id == conv.id)
                            .order_by(Message.created_at.asc())
                        )
                    ).scalars()
                )
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
                    zf.write(
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

            manifest = {
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
                    }
                    for i in items
                ],
                "limitations": [
                    "Canvas scenes are collaborative CRDTs; only their "
                    "extracted text is included.",
                    "Sheets export computed display values, not formulas.",
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
@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_workspace(
    request: Request,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Build a new workspace from a zip of Markdown files.

    Understands the folder layout of Obsidian vaults and Notion /
    Confluence Markdown exports: ``.md`` files become collaborative notes at
    the top level (folders were removed as a grouping primitive, so the
    directory path is folded into each note's title instead). Non-Markdown
    entries (images, attachments) are skipped and counted in the response.
    """
    from app.files.system_folders import create_workspace_folder_tree
    from app.workspaces.content_seed import create_note_with_item
    from app.workspaces.knowledge import index_note_for_workspace

    try:
        zf = zipfile.ZipFile(file.file)
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="That isn't a zip archive.",
        )

    # Collect the importable entries first so validation happens before
    # any rows are created.
    entries: list[tuple[str, zipfile.ZipInfo]] = []
    skipped = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        # Zips from macOS bundle metadata; Notion exports carry asset dirs.
        parts = [p for p in posixpath.normpath(name).split("/") if p]
        if (
            not parts
            or any(p.startswith(("__MACOSX", ".")) for p in parts)
            or ".." in parts
        ):
            continue
        ext = posixpath.splitext(name)[1].lower()
        if ext not in _MD_EXTS or info.file_size > _IMPORT_MAX_NOTE_BYTES:
            skipped += 1
            continue
        entries.append(("/".join(parts), info))
    if not entries:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No Markdown files found in the archive.",
        )
    if len(entries) > _IMPORT_MAX_NOTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Imports are capped at {_IMPORT_MAX_NOTES} notes; "
            f"the archive holds {len(entries)}.",
        )

    ws_title = (title or "").strip()[:100] or (
        posixpath.splitext(file.filename or "")[0].strip() or "Imported workspace"
    )[:100]
    ws = Workspace(user_id=user.id, title=ws_title)
    db.add(ws)
    await db.flush()
    ws_folder = await create_workspace_folder_tree(db, user, ws.title)
    ws.root_folder_id = ws_folder.id

    # Folders were removed as a workspace grouping primitive, so a nested
    # export can't be rebuilt as a folder tree (and notebooks can't nest).
    # Import every note at the top level instead, folding the sub-directory
    # path into the title so the original structure stays legible — e.g.
    # "Specs/2024/API.md" becomes a note titled "Specs / 2024 / API".
    note_item_ids: list[uuid.UUID] = []
    for path, info in sorted(entries, key=lambda e: e[0]):
        raw = zf.read(info)
        markdown = raw.decode("utf-8", errors="replace")
        stem = posixpath.splitext(path)[0]  # drop ".md", keep the dir path
        note_title = stem.replace("/", " / ")[:200]
        item = await create_note_with_item(
            db,
            ws=ws,
            owner=user,
            creator_id=user.id,
            title=note_title,
            markdown=markdown,
            parent_id=None,
        )
        note_item_ids.append(item.id)

    await record_event(
        db,
        event_type=EVENT_WORKSPACE_IMPORTED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={ws.id}) — {len(note_item_ids)} note(s), '
        f"{skipped} entr(ies) skipped",
    )
    await db.commit()

    # RAG-index the imported notes off-request; each call owns a session.
    for item_id in note_item_ids:
        background.add_task(index_note_for_workspace, ws.id, item_id)

    return {
        "id": str(ws.id),
        "title": ws.title,
        "notes": len(note_item_ids),
        "skipped": skipped,
    }


__all__ = ["router"]

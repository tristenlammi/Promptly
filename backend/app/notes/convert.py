"""Turning a note into something else (``docs/notes-plan.md`` §3 ⋯ menu, §6).

* :func:`make_copy` — **Make a copy**: a new note of your own with the same
  words, list, colour and your labels. Pictures and recordings come too:
  ones you added are the same files (nothing is stored twice); ones someone
  else added are copied into your ``My files › Notes`` (they count against
  your storage, like any file of yours).
* :func:`to_document` / :func:`undo_document` — **Open as document**: a
  Document in your Drive with the note's words (and its list as a
  checklist); the note remembers it (``doc_file_id``), shows a card that
  opens it, and goes to your archive. The note's owner only, since the
  card is on the note for everyone. Undo takes the document to Trash and
  brings the note back.
* :func:`to_tasks` / :func:`undo_tasks` — **Turn into tasks**: tasks in your
  own Tasks, on the list you pick, each linked to the note. Undo removes
  exactly those tasks (only while they're still open).

Make an event needs nothing here: the app opens Calendar's new-event sheet
with the note's title and words (``/calendar?new=1&…``).
"""
from __future__ import annotations

import asyncio
import builtins
import logging
import os
import uuid
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import access
from .models import Note, NoteAttachment

logger = logging.getLogger("promptly.notes.convert")

MAX_TASKS = 50


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


# ================================================================== copy


async def _copy_file(db: AsyncSession, user: User, src: Any) -> Any | None:
    """Someone else's picture or recording, copied into your My files ›
    Notes. None when it can't be (gone, or no room left)."""
    from shutil import copyfile, copytree

    from app.files.derivatives import derived_dir
    from app.files.models import UserFile
    from app.files.quota import get_quota
    from app.files.storage import absolute_path, ensure_bucket, storage_path_for
    from app.files.system_folders import ensure_notes

    if src is None or not src.storage_path:
        return None
    if not (await get_quota(db, user)).can_fit(src.size_bytes or 0):
        return None
    new_id = uuid.uuid4()
    rel = storage_path_for(user.id, new_id, os.path.splitext(src.storage_path)[1])
    ensure_bucket(user.id)
    try:
        dest = absolute_path(rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(copyfile, absolute_path(src.storage_path), dest)
    except (OSError, ValueError):
        logger.warning("copying %s for a note copy failed", src.id, exc_info=True)
        return None
    # A recording's seekable playback copy comes too (it's made once, by the
    # transcription job).
    old_derived = derived_dir(src.id)
    if (src.mime_type or "").startswith(("audio/", "video/webm")) and old_derived.is_dir():
        try:
            await asyncio.to_thread(copytree, old_derived, derived_dir(new_id), dirs_exist_ok=True)
        except OSError:
            pass
    folder = await ensure_notes(db, user)
    base, ext = os.path.splitext(src.filename or "file")
    for n in range(5):
        name = src.filename if n == 0 else f"{base} ({n + 1}){ext}"
        row = UserFile(
            id=new_id, user_id=user.id, folder_id=folder.id, filename=name, original_filename=src.original_filename or name,
            mime_type=src.mime_type, size_bytes=src.size_bytes, storage_path=rel, content_text=src.content_text,
            content_sha256=src.content_sha256, sha1=src.sha1, md5=src.md5, verified_at=src.verified_at,
        )
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
            return row
        except Exception:  # noqa: BLE001 — a name clash: try the next name
            continue
    return None


async def make_copy(db: AsyncSession, user: User, note: Note, copy_id: uuid.UUID) -> tuple[Note, bool]:
    """Your own copy of ``note`` (see the module doc). A retry with the same
    id gets the copy already made. Flushed."""
    from . import service
    from .attachments import live_rows

    existing = await db.get(Note, copy_id)
    if existing is not None:
        if existing.owner_id == user.id:
            return existing, False
        raise access.not_found()
    items = await service.items_of(db, note.id)
    labels = (await service._labels(db, user, [note.id])).get(note.id, [])
    src_title = note.title.strip()
    copy, _made = await service.create(
        db, user, note_id=copy_id, kind=note.kind, title=src_title,
        body_doc=note.body_doc if note.kind == "text" else None,
        items=[
            {"id": uuid.uuid4(), "text": i.text, "checked": i.checked, "indent": bool(i.parent_id)} for i in items
        ] if note.kind == "list" else None,
        color=note.color, tag_ids=[uuid.UUID(lb["id"]) for lb in labels], source="web",
    )
    copy.list_opts = dict(note.list_opts or {})
    media_jobs: list[uuid.UUID] = []
    skipped = 0
    for att, file, _media in await live_rows(db, [note.id]):
        target = file
        if file.user_id != user.id:
            target = await _copy_file(db, user, file)
            if target is None:
                skipped += 1
                continue
            if att.kind == "image":
                media_jobs.append(target.id)
        state = att.transcript_state
        if att.kind == "audio" and state not in ("done", "off", "failed"):
            # Still being worked out on the original: what's there now.
            state = "done" if att.transcript else "off"
        db.add(NoteAttachment(
            note_id=copy.id, file_id=target.id, kind=att.kind, position=att.position, added_by=user.id,
            width=att.width, height=att.height, duration_ms=att.duration_ms, peaks=att.peaks, transcript=att.transcript,
            transcript_state=state if att.kind == "audio" else None,
            transcript_lang=att.transcript_lang, transcribed_at=att.transcribed_at,
        ))
    await db.flush()
    await service.refresh_search_text(db, copy)
    await db.flush()
    copy._skipped_attachments = skipped  # type: ignore[attr-defined]
    copy._media_jobs = media_jobs  # type: ignore[attr-defined]
    return copy, True


async def after_copy(copy: Note) -> None:
    """After commit: pictures copied from someone else get their thumbnails."""
    from app.tasks.queue import enqueue_media

    for fid in getattr(copy, "_media_jobs", []) or []:
        await enqueue_media(fid)


# ================================================================== document


def _marks_md(node: dict) -> str:
    text = str(node.get("text") or "")
    if not text.strip():
        return text
    lead, core, trail = text[: len(text) - len(text.lstrip())], text.strip(), text[len(text.rstrip()):]
    for m in node.get("marks") or []:
        t = m.get("type")
        if t == "bold":
            core = f"**{core}**"
        elif t == "italic":
            core = f"*{core}*"
        elif t == "link":
            href = str((m.get("attrs") or {}).get("href") or "")
            if href:
                core = f"[{core}]({href})"
    return lead + core + trail


def note_markdown(note: Note, items: list[Any]) -> str:
    """The note as Markdown: its title as a heading, paragraphs and
    headings, and a list as a checklist (indented items one level in)."""
    out: list[str] = []
    if note.kind == "list":
        for i in items:
            if i.text.strip():
                out.append(("  " if i.parent_id else "") + ("- [x] " if i.checked else "- [ ] ") + i.text.replace("\n", " "))
        return "\n".join(out) + "\n"
    for block in (note.body_doc or {}).get("content") or []:
        line = "".join(
            "  \n" if c.get("type") == "hardBreak" else _marks_md(c) for c in block.get("content") or [] if isinstance(c, dict)
        )
        if block.get("type") == "heading":
            level = (block.get("attrs") or {}).get("level") or 2
            out.append(("#" * (int(level) + 1)) + " " + line if line.strip() else "")
        else:
            out.append(line)
    return "\n\n".join(x for x in out) + "\n"


async def to_document(db: AsyncSession, user: User, note: Note, folder_id: uuid.UUID | None) -> Any:
    """A Document with the note's words, linked from the note, and the note
    archived (for you). Owner only. Returns the document's row. Flushed."""
    from app.files.documents_router import document_from_markdown

    from . import service

    if note.owner_id != user.id:
        raise service.forbidden("Only the note's owner can turn it into a document.")
    if folder_id is not None:
        from app.files.models import FileFolder

        folder = await db.get(FileFolder, folder_id)
        if folder is None or folder.user_id != user.id or folder.trashed_at is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That folder isn't here.")
    items = await service.items_of(db, note.id)
    md = note_markdown(note, items)
    name = service.display_title(note)[:200]
    row = await document_from_markdown(db, user, name=name, folder_id=folder_id, markdown=md)
    note.doc_file_id = row.id
    note.change_seq += 1
    await service.set_state(db, user, note, archived=True)
    await db.flush()
    return row


async def undo_document(db: AsyncSession, user: User, note: Note) -> bool:
    """Undo Open as document: the document to Trash (if it's still yours and
    there), the card off, the note back from your archive. Flushed."""
    from datetime import datetime, timezone

    from app.files.models import UserFile

    from . import service

    if note.owner_id != user.id:
        raise service.forbidden("Only the note's owner can do that.")
    if note.doc_file_id is None:
        return False
    row = await db.get(UserFile, note.doc_file_id)
    if row is not None and row.user_id == user.id and row.trashed_at is None:
        row.trashed_at = datetime.now(timezone.utc)
    note.doc_file_id = None
    note.change_seq += 1
    await service.set_state(db, user, note, archived=False)
    await db.flush()
    return True


async def document_card(db: AsyncSession, user: User, note: Note) -> dict[str, Any] | None:
    """The "moved to a document" card, as ``user`` sees it (None when they
    can't open the document, or it's gone)."""
    from app.files.access import can_read
    from app.files.models import UserFile
    from app.files.office_templates import office_title

    if note.doc_file_id is None:
        return None
    row = await db.get(UserFile, note.doc_file_id)
    if row is None or row.trashed_at is not None or not await can_read(db, row.id, user.id):
        return None
    from app.files.office_router import editor_path

    return {"id": str(row.id), "title": office_title(row), "href": editor_path(row) or f"/files/doc/{row.id}"}


# ================================================================== tasks


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    due: str | None = Field(default=None, max_length=10)
    time: str | None = Field(default=None, max_length=5)


class ToTasksIn(BaseModel):
    list: str | None = Field(default=None, max_length=100, description="The Tasks list's name; none = the Inbox")
    tasks: builtins.list[TaskIn] = Field(min_length=1, max_length=MAX_TASKS)


class UndoTasksIn(BaseModel):
    file_id: uuid.UUID
    task_ids: list[str] = Field(min_length=1, max_length=MAX_TASKS)


async def task_lists(db: AsyncSession, user: User) -> dict[str, Any]:
    """The lists in your Tasks (for "Turn into tasks"), or why there aren't any."""
    from app.items import service as items

    from .reminders import tasks_available

    if not await tasks_available(db):
        return {"available": False, "lists": []}
    found = await items.list_items(db, user, "tasks", limit=1, archives=False)
    if not found:
        from app.items.kinds.tasks import template

        names = [{"id": x["id"], "name": x["name"], "color": x.get("color")} for x in template(None)["lists"]]  # type: ignore[arg-type]
        return {"available": True, "lists": names}
    data = found[0][1].data or {}
    return {"available": True, "lists": [{"id": x["id"], "name": x["name"], "color": x.get("color")} for x in data.get("lists", [])]}


async def to_tasks(db: AsyncSession, user: User, note: Note, body: ToTasksIn) -> dict[str, Any]:
    """Make the tasks in your own Tasks, each linked to the note. Flushed."""
    from datetime import date

    from app.items import service as items
    from app.items.kinds.tasks.models import _clock
    from app.links.service import add_link

    from .reminders import _edit_tasks, tasks_available

    if not await tasks_available(db):
        raise _bad("Tasks is turned off on this server.")
    rows: list[dict[str, Any]] = []
    for t in body.tasks:
        new: dict[str, Any] = {"title": t.title.strip()[:500], "notes": "From a note in Notes."}
        if body.list and body.list.strip().lower() != "inbox":
            new["list"] = body.list.strip()
        if t.due:
            try:
                new["due"] = date.fromisoformat(t.due).isoformat()
            except ValueError:
                raise _bad("A task's day isn't a date.") from None
            try:
                tm = _clock(t.time)
            except ValueError:
                tm = None
            if tm:
                new["time"] = tm
        if new["title"]:
            rows.append(new)
    if not rows:
        raise _bad("Pick at least one task.")

    async def add(ctx: Any, spec: Any, data: dict) -> list[str]:
        out = await items.run_action(ctx, spec, data, "add_tasks", {"tasks": rows})
        return [r["id"] for r in out.result or []]

    try:
        fid, ids = await _edit_tasks(db, user, None, add)
    except (items.ItemError, items.ItemNotFound) as e:
        raise _bad(str(e) or "Couldn't add the tasks.") from e
    except Exception as e:  # noqa: BLE001 — an action refusing (a full file)
        from app.items.spec import ActionError

        if isinstance(e, ActionError):
            raise _bad(str(e)) from e
        raise
    for tid in ids:
        try:
            await add_link(db, user, ("note", str(note.id)), ("task", f"{fid}:{tid}"))
        except Exception:  # noqa: BLE001 — the tasks work without their link
            logger.warning("linking note %s to task %s failed", note.id, tid, exc_info=True)
    await db.flush()
    return {"file_id": str(fid), "task_ids": ids, "count": len(ids), "list": body.list or "Inbox", "href": f"/apps/tasks/{fid}"}


async def undo_tasks(db: AsyncSession, user: User, note: Note, body: UndoTasksIn) -> int:
    """Take back tasks "Turn into tasks" just made: those ids, from your own
    Tasks, only while they're open. Returns how many went. Flushed."""
    from app.items import service as items
    from app.links.models import EntityLink

    from .reminders import _edit_tasks

    want = set(body.task_ids)

    async def drop(_ctx: Any, _spec: Any, data: dict) -> list[str]:
        gone = [t["id"] for t in data.get("tasks", []) if t.get("id") in want and not t.get("done")]
        data["tasks"] = [t for t in data.get("tasks", []) if t.get("id") not in gone]
        return gone

    try:
        _fid, gone = await _edit_tasks(db, user, body.file_id, drop)
    except (items.ItemNotFound, items.ItemError):
        return 0
    refs = [f"{body.file_id}:{t}" for t in gone]
    if refs:
        from sqlalchemy import and_, delete, or_

        await db.execute(
            delete(EntityLink).where(
                EntityLink.link_type == "link",
                or_(
                    and_(EntityLink.source_kind == "note", EntityLink.source_id == str(note.id), EntityLink.target_kind == "task", EntityLink.target_id.in_(refs)),
                    and_(EntityLink.target_kind == "note", EntityLink.target_id == str(note.id), EntityLink.source_kind == "task", EntityLink.source_id.in_(refs)),
                ),
            )
        )
    await db.flush()
    return len(gone)


__all__ = [
    "TaskIn", "ToTasksIn", "UndoTasksIn", "after_copy", "document_card", "make_copy", "note_markdown", "task_lists",
    "to_document", "to_tasks", "undo_document", "undo_tasks",
]

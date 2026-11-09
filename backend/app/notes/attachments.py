"""A note's pictures and recordings (``docs/notes-plan.md`` §3, §5).

An attachment is a Drive file of whoever added it, in their
``My files › Notes`` (uploaded with tus ``route=note``) — or, for a photo
picked from their library, that photo itself (referenced, not copied). So
it counts against the adder's storage like any file, and trashing it in
Files takes it out of the note (restoring it brings it back).

Only your own files can go in (never one someone shared with you: putting
it in a note would show it to everyone on the note). The attachment's id is
made by the client, so a retried add never makes two. Anyone who can open
the note can add and remove; the files themselves stay in their owner's
Drive.

Bytes reach the people on the note through signed links
(:mod:`app.notes.media`), never through Drive access.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from .models import Note, NoteAttachment

MAX_ATTACHMENTS = 50
COVERS = 3


def not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That picture or recording isn't here.")


def kind_of(mime: str | None) -> str | None:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("audio/") or m == "video/webm":
        return "audio"
    return None


def live_join():  # noqa: ANN201 — the UserFile join that leaves out trashed files
    from app.files.models import UserFile

    return and_(UserFile.id == NoteAttachment.file_id, UserFile.trashed_at.is_(None))


async def live_rows(db: AsyncSession, note_ids: list[uuid.UUID]) -> list[tuple[NoteAttachment, Any, Any]]:
    """(attachment, file, media) for each attachment still there, in order."""
    from app.files.models import FileMedia, UserFile

    if not note_ids:
        return []
    rows = await db.execute(
        select(NoteAttachment, UserFile, FileMedia)
        .join(UserFile, live_join())
        .outerjoin(FileMedia, FileMedia.file_id == UserFile.id)
        .where(NoteAttachment.note_id.in_(note_ids))
        .order_by(NoteAttachment.note_id, NoteAttachment.position, NoteAttachment.created_at, NoteAttachment.id)
    )
    return [(a, f, m) for a, f, m in rows.all()]


def out(att: NoteAttachment, file: Any, media: Any, user: User) -> dict[str, Any]:
    from . import media as M

    width, height = att.width, att.height
    if media is not None and att.kind == "image":
        width = width or media.width
        height = height or media.height
    return {
        "id": str(att.id),
        "kind": att.kind,
        "file_id": str(att.file_id) if att.file_id else None,
        "filename": file.filename if file is not None else None,
        "mime": file.mime_type if file is not None else None,
        "size": file.size_bytes if file is not None else None,
        "position": att.position,
        "added_by": str(att.added_by) if att.added_by else None,
        "created_at": att.created_at,
        "width": width,
        "height": height,
        "duration_ms": att.duration_ms,
        "peaks": att.peaks,
        "transcript": att.transcript,
        "transcript_state": att.transcript_state,
        "transcribed_at": att.transcribed_at,
        "urls": M.urls_for(att, file, media, user),
    }


async def for_note(db: AsyncSession, user: User, note: Note) -> list[dict[str, Any]]:
    return [out(a, f, m, user) for a, f, m in await live_rows(db, [note.id])]


async def covers(db: AsyncSession, user: User, note_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """The first few pictures of each note, for its card (tile links only)."""
    from app.files.models import FileMedia, UserFile

    from . import media as M

    if not note_ids:
        return {}
    rn = func.row_number().over(partition_by=NoteAttachment.note_id, order_by=(NoteAttachment.position, NoteAttachment.id)).label("rn")
    sub = (
        select(NoteAttachment.id, rn)
        .join(UserFile, live_join())
        .where(NoteAttachment.note_id.in_(note_ids), NoteAttachment.kind == "image")
        .subquery()
    )
    rows = await db.execute(
        select(NoteAttachment, UserFile, FileMedia)
        .join(sub, sub.c.id == NoteAttachment.id)
        .join(UserFile, UserFile.id == NoteAttachment.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == UserFile.id)
        .where(sub.c.rn <= COVERS)
        .order_by(NoteAttachment.position, NoteAttachment.id)
    )
    found: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for a, f, m in rows.all():
        urls = M.urls_for(a, f, m, user)
        found.setdefault(a.note_id, []).append({
            "id": str(a.id),
            "thumb": urls["thumb"] or (urls["original"] if (f.mime_type or "").startswith("image/") else None),
            "width": a.width or (m.width if m is not None else None),
            "height": a.height or (m.height if m is not None else None),
        })
    return found


async def add(
    db: AsyncSession,
    user: User,
    note: Note,
    *,
    attachment_id: uuid.UUID,
    file_id: uuid.UUID,
    kind: str | None = None,
    duration_ms: int | None = None,
    peaks: list[float] | None = None,
    transcribe: bool,
) -> tuple[NoteAttachment, bool]:
    """Attach one of ``user``'s own files. Returns (attachment, made now)."""
    from app.files.models import FileMedia, UserFile

    existing = await db.get(NoteAttachment, attachment_id)
    if existing is not None:
        if existing.note_id != note.id or existing.file_id != file_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That id is already used for something else.")
        return existing, False
    file = await db.get(UserFile, file_id)
    if file is None or file.user_id != user.id or file.trashed_at is not None or not file.storage_path:
        # Not yours (or gone): the same answer as a file that isn't there.
        raise not_found()
    found = kind_of(file.mime_type)
    if found is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only pictures and recordings can go in a note.")
    if kind and kind != found:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"That file is {'a picture' if found == 'image' else 'a recording'}.")
    count = (
        await db.execute(select(func.count()).select_from(NoteAttachment).where(NoteAttachment.note_id == note.id))
    ).scalar_one()
    if count >= MAX_ATTACHMENTS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"A note can hold {MAX_ATTACHMENTS} pictures and recordings.")
    top = (
        await db.execute(select(func.max(NoteAttachment.position)).where(NoteAttachment.note_id == note.id))
    ).scalar_one()
    att = NoteAttachment(
        id=attachment_id,
        note_id=note.id,
        file_id=file.id,
        kind=found,
        position=(top or 0) + 1,
        added_by=user.id,
    )
    if found == "image":
        media = await db.get(FileMedia, file.id)
        if media is not None:
            att.width, att.height = media.width, media.height
    else:
        # What the recorder measured shows at once; the worker's own reading
        # replaces it.
        if duration_ms is not None and 0 < duration_ms < 24 * 3600 * 1000:
            att.duration_ms = int(duration_ms)
        if peaks:
            att.peaks = [round(min(1.0, max(0.0, float(p))), 3) for p in peaks[:200]]
        att.transcript_state = "pending" if transcribe else "off"
    db.add(att)
    await db.flush()
    return att, True


async def load(db: AsyncSession, note: Note, attachment_id: uuid.UUID) -> NoteAttachment:
    att = await db.get(NoteAttachment, attachment_id)
    if att is None or att.note_id != note.id or att.file_id is None:
        raise not_found()
    return att


async def remove(db: AsyncSession, note: Note, attachment_id: uuid.UUID) -> bool:
    """Out of the note (the file stays in its owner's Drive). Removing one
    that's already gone is fine (a retry)."""
    att = await db.get(NoteAttachment, attachment_id)
    if att is None or att.note_id != note.id:
        return False
    await db.delete(att)
    await db.flush()
    return True


__all__ = ["COVERS", "MAX_ATTACHMENTS", "add", "covers", "for_note", "kind_of", "live_join", "live_rows", "load", "not_found", "out", "remove"]

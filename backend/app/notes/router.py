"""Notes API, mounted at ``/api/notes``. See ``docs/notes-plan.md`` §5.

Every route loads the note through :mod:`app.notes.access` — 404 for
anything the caller can't open, never 403 — commits, then tells the
people on the note through their live stream (ids only).

    GET    /notes?view=home|archive|trash|reminders&label=&color=&type=&q=&cursor=
    GET    /notes/labels                    your labels on notes, with counts
    GET    /notes/events                    live updates (SSE)
    POST   /notes                           create {client_id, kind, …}
    POST   /notes/bulk                      {ids, action: pin|unpin|archive|unarchive|color|label|unlabel|trash}
    DELETE /notes/trash                     empty your Notes trash
    GET    /notes/{id}                      the whole note
    PATCH  /notes/{id}                      {base_revision, title?, body_doc?|text?, color?, kind?, list_opts?}
    POST   /notes/{id}/items                {id, text, after_id?, parent_id?, checked?}
    POST   /notes/{id}/items/bulk           {action: untick_all|delete_ticked|sort}
    PATCH  /notes/{id}/items/{iid}          {text?, checked?, parent_id?, position?}
    DELETE /notes/{id}/items/{iid}
    PUT    /notes/{id}/me                   {pinned?, archived?, position?, seen?}
    PUT    /notes/{id}/labels               {tag_ids}
    GET    /notes/{id}/members · POST {user_ids} (owner) · DELETE /{uid} (owner; your own id = Leave)
    GET    /notes/{id}/versions · GET …/{vid} · POST …/{vid}/restore
    DELETE /notes/{id}                      owner → Trash; member → Leave
    POST   /notes/{id}/restore              out of Trash (owner)
    DELETE /notes/{id}/forever              gone for good (owner)
    POST   /notes/{id}/attachments          {id, file_id, kind?, duration_ms?, peaks?} — your own picture or recording
    DELETE /notes/{id}/attachments/{aid}    out of the note (the file stays in Drive)
    POST   /notes/{id}/attachments/{aid}/transcribe   try the words again
    GET|PUT /notes/admin/transcription      the admin's switch for transcribing voice notes
    PUT    /notes/{id}/reminder             {due, time?, repeat?} — your reminder (a task in your Tasks)
    DELETE /notes/{id}/reminder             take your reminder off (its open task goes too)
    POST   /notes/{id}/ai/{action}          tidy|to_list|title|to_tasks|to_event → a proposal (nothing saved)
    POST   /notes/{id}/copy                 {client_id} — Make a copy (yours)
    POST   /notes/{id}/to-document          {folder_id?} — Open as document (owner); DELETE = undo
    GET    /notes/to-tasks/lists            the lists in your Tasks
    POST   /notes/{id}/to-tasks             {list?, tasks} — Turn into tasks; POST …/undo {file_id, task_ids}
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.database import get_db

from . import access, events, push, reminders, service, transcription
from . import ai as note_ai
from . import attachments as attach
from . import convert
from .body import BodyError
from .models import Note

router = APIRouter()


def _body_error(e: BodyError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


async def _tell_all(db: AsyncSession, note: Note) -> None:
    """After commit: everyone on the note refetches it."""
    await events.publish(await access.participants(db, note), events.note_event(note))


async def _tell_me(user: User, note: Note) -> None:
    """After commit: only your own devices (your pin, order, labels)."""
    await events.publish([user.id], events.note_event(note))


# ================================================================== schemas


class ItemIn(BaseModel):
    id: uuid.UUID | None = None
    text: str = Field(default="", max_length=1000)
    checked: bool = False
    indent: bool = False  # under the item above


class NoteIn(BaseModel):
    client_id: uuid.UUID | None = None
    kind: Literal["text", "list"] = "text"
    title: str = Field(default="", max_length=300)
    body_doc: dict[str, Any] | None = None
    text: str | None = Field(default=None, max_length=40_000)
    items: list[ItemIn] = Field(default_factory=list, max_length=service.MAX_ITEMS)
    color: str = Field(default="default", max_length=16)
    tag_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    pinned: bool = False
    archived: bool = False
    source: str = Field(default="web", max_length=8)


class NotePatch(BaseModel):
    base_revision: int
    title: str | None = Field(default=None, max_length=300)
    body_doc: dict[str, Any] | None = None
    text: str | None = Field(default=None, max_length=40_000)
    color: str | None = Field(default=None, max_length=16)
    kind: Literal["text", "list"] | None = None
    list_opts: dict[str, bool] | None = None
    # "ai": an AI proposal being applied — the note as it was is kept as a
    # version first.
    checkpoint: Literal["ai"] | None = None


class ItemAdd(BaseModel):
    id: uuid.UUID
    text: str = Field(default="", max_length=1000)
    after_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None = None
    checked: bool = False


class ItemPatch(BaseModel):
    text: str | None = Field(default=None, max_length=1000)
    checked: bool | None = None
    parent_id: uuid.UUID | None = None  # send null to outdent
    position: float | None = None


class ItemsBulk(BaseModel):
    action: Literal["untick_all", "delete_ticked", "sort"]


class MeIn(BaseModel):
    pinned: bool | None = None
    archived: bool | None = None
    position: float | None = None
    seen: bool | None = None


class LabelsIn(BaseModel):
    tag_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)


class MembersIn(BaseModel):
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=service.MAX_MEMBERS)


class AttachIn(BaseModel):
    id: uuid.UUID
    file_id: uuid.UUID
    kind: Literal["image", "audio"] | None = None
    # What the recorder measured (the worker's own reading replaces them).
    duration_ms: int | None = Field(default=None, ge=0)
    peaks: list[float] | None = Field(default=None, max_length=200)


class TranscriptionIn(BaseModel):
    on: bool


class CopyIn(BaseModel):
    client_id: uuid.UUID


class ToDocumentIn(BaseModel):
    folder_id: uuid.UUID | None = None


class BulkIn(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    action: Literal["pin", "unpin", "archive", "unarchive", "color", "label", "unlabel", "trash"]
    color: str | None = Field(default=None, max_length=16)
    tag_id: uuid.UUID | None = None


# ================================================================== lists


@router.get("")
async def list_notes(
    view: str = Query("home", max_length=12),
    label: uuid.UUID | None = None,
    color: str | None = Query(None, max_length=16),
    type: str | None = Query(None, max_length=12),  # noqa: A002 — the API's word
    q: str | None = Query(None, max_length=200),
    cursor: str | None = Query(None, max_length=400),
    limit: int = Query(60, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return await service.list_cards(db, user, view=view, label=label, color=color, type_=type, q=q, cursor=cursor, limit=limit)


@router.get("/labels")
async def labels(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return {"labels": await service.label_counts(db, user)}


@router.get("/to-tasks/lists")
async def task_lists(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """The lists in your Tasks, for "Turn into tasks"."""
    return await convert.task_lists(db, user)


# ------------------------------------------------------------------ admin


def _transcription_out(cfg: transcription.Config) -> dict:
    return {"on": cfg.on, "backend": cfg.backend, "choice": cfg.choice, "ready": cfg.ready}


@router.get("/admin/transcription")
async def transcription_status(db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    """Whether voice notes are transcribed, for everyone on this Promptly."""
    _ = user
    return _transcription_out(await transcription.config(db))


@router.put("/admin/transcription")
async def set_transcription(body: TranscriptionIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    _ = user
    return _transcription_out(await transcription.set_choice(db, body.on))


@router.get("/events")
async def live(request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> StreamingResponse:
    # The stream lives for hours on a phone; holding the request's pooled DB
    # connection that long drains the pool (reference_sse_db_pool).
    await db.close()
    return StreamingResponse(
        events.stream(user.id, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_note(body: NoteIn, response: Response, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    try:
        note, created = await service.create(
            db, user, note_id=body.client_id, kind=body.kind, title=body.title, body_doc=body.body_doc, text=body.text,
            items=[i.model_dump() for i in body.items], color=body.color, tag_ids=body.tag_ids, pinned=body.pinned,
            archived=body.archived, source=body.source,
        )
    except BodyError as e:
        await db.rollback()
        raise _body_error(e) from e
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if created:
        await _tell_me(user, note)
    else:
        response.status_code = status.HTTP_200_OK
    return {"note": await service.full_out(db, user, note)}


@router.post("/bulk")
async def bulk(body: BulkIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Do one thing to several notes. Ones you can't open are skipped (and
    not named)."""
    if body.action == "color" and body.color is None:
        raise service.bad("Pick a colour.")
    if body.action in ("label", "unlabel") and body.tag_id is None:
        raise service.bad("Pick a label.")
    done: list[Note] = []
    left: list[Note] = []
    for nid in dict.fromkeys(body.ids):
        try:
            note = await access.load(db, user, nid, lock=True)
        except HTTPException:
            continue
        if body.action in ("pin", "unpin"):
            await service.set_state(db, user, note, pinned=body.action == "pin")
        elif body.action in ("archive", "unarchive"):
            await service.set_state(db, user, note, archived=body.action == "archive")
        elif body.action in ("label", "unlabel"):
            assert body.tag_id is not None
            await service.add_label(db, user, note, body.tag_id, on=body.action == "label")
        elif body.action == "color":
            changes = await service.clean_changes({"color": body.color})
            await service.patch(db, user, note, note.revision, changes)
        else:  # trash: yours go to Trash, others' you leave
            if note.owner_id == user.id:
                await service.trash(db, user, note)
            else:
                await service.remove_member(db, user, note, user.id)
                left.append(note)
        done.append(note)
    await db.commit()
    for note in done:
        if body.action in ("color", "trash"):
            people = await access.participants(db, note)
            if body.action == "trash" and note not in left:
                await events.publish([p for p in people if p != user.id], events.gone_event(note.id))
                await _tell_me(user, note)
            elif note in left:
                await events.publish([user.id], events.gone_event(note.id))
                await events.publish(people, events.note_event(note))
            else:
                await events.publish(people, events.note_event(note))
        else:
            await _tell_me(user, note)
    return {"done": [str(n.id) for n in done], "skipped": len(set(body.ids)) - len(done)}


@router.delete("/trash")
async def empty_trash(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    notes = await service.trashed_notes(db, user)
    n = await service.purge(db, notes)
    await db.commit()
    for note in notes:
        await events.publish([user.id], events.gone_event(note.id))
    return {"deleted": n}


# ================================================================== one note


@router.get("/{note_id}")
async def get_note(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    try:
        note = await access.load(db, user, note_id)
    except HTTPException:
        # The owner can still read a note in their Trash.
        note = await access.load(db, user, note_id, trashed=True)
    return {"note": await service.full_out(db, user, note)}


@router.patch("/{note_id}")
async def patch_note(note_id: uuid.UUID, body: NotePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    raw = body.model_dump(exclude_unset=True)
    raw.pop("base_revision", None)
    checkpoint = raw.pop("checkpoint", None)
    try:
        changes = await service.clean_changes(raw)
        changed = await service.patch(db, user, note, body.base_revision, changes, reason=checkpoint or "edit")
    except service.Stale as e:
        # Nothing was written yet, and the row is locked: this is the latest.
        detail = {
            "message": "Someone changed this note while you were editing. Here's the latest.",
            "note": jsonable_encoder(await service.full_out(db, user, e.note)),
        }
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from e
    except BodyError as e:
        await db.rollback()
        raise _body_error(e) from e
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if changed:
        await _tell_all(db, note)
    return {"note": await service.full_out(db, user, note), "changed": changed}


# ------------------------------------------------------------------ items


@router.post("/{note_id}/items", status_code=status.HTTP_201_CREATED)
async def add_item(
    note_id: uuid.UUID, body: ItemAdd, response: Response, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    try:
        item, created = await service.add_item(
            db, user, note, item_id=body.id, text=body.text, after_id=body.after_id, parent_id=body.parent_id, checked=body.checked
        )
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if created:
        await _tell_all(db, note)
    else:
        response.status_code = status.HTTP_200_OK
    return {"item": service.item_out(item), "revision": note.revision, "change_seq": note.change_seq}


# Before /items/{item_id}: "bulk" isn't an id.
@router.post("/{note_id}/items/bulk")
async def items_bulk(note_id: uuid.UUID, body: ItemsBulk, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    try:
        changed = await service.bulk_items(db, user, note, body.action)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if changed:
        await _tell_all(db, note)
    items = await service.items_of(db, note.id)
    return {"items": [service.item_out(i) for i in items], "revision": note.revision, "change_seq": note.change_seq}


@router.patch("/{note_id}/items/{item_id}")
async def patch_item(
    note_id: uuid.UUID, item_id: uuid.UUID, body: ItemPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    fields = body.model_dump(exclude_unset=True)
    for k in ("text", "checked", "position"):
        if k in fields and fields[k] is None:
            fields.pop(k)
    try:
        item, changed = await service.update_item(db, user, note, item_id, fields)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if changed:
        await _tell_all(db, note)
    return {"item": service.item_out(item), "revision": note.revision, "change_seq": note.change_seq}


@router.delete("/{note_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(note_id: uuid.UUID, item_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    note = await access.load(db, user, note_id, lock=True)
    try:
        changed = await service.delete_item(db, user, note, item_id)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if changed:
        await _tell_all(db, note)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ yours


@router.put("/{note_id}/me")
async def put_me(note_id: uuid.UUID, body: MeIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id)
    st = await service.set_state(db, user, note, pinned=body.pinned, archived=body.archived, position=body.position, seen=body.seen)
    await db.commit()
    await _tell_me(user, note)
    return {"me": service.state_out(st)}


@router.put("/{note_id}/labels")
async def put_labels(note_id: uuid.UUID, body: LabelsIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id)
    try:
        out = await service.set_labels(db, user, note, body.tag_ids)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    await _tell_me(user, note)
    return {"labels": out}


# ------------------------------------------------------------------ sharing


async def _members_out(db: AsyncSession, note: Note) -> dict:
    mems = await service.members_of(db, note)
    people = {note.owner_id, *(m.user_id for m in mems)}
    return {
        "owner_id": str(note.owner_id),
        "members": [{"user_id": str(m.user_id), "added_by": str(m.added_by) if m.added_by else None, "added_at": m.added_at} for m in mems],
        "users": await service.users_map(db, people),
        "note": "Only the people you add can see this note.",
    }


@router.get("/{note_id}/members")
async def get_members(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id)
    return await _members_out(db, note)


@router.post("/{note_id}/members")
async def add_members(note_id: uuid.UUID, body: MembersIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    try:
        new = await service.add_members(db, user, note, body.user_ids)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if new:
        await _tell_all(db, note)
        await push.shared_with(note_id=note.id, title=note.title, actor=user, user_ids=new)
    return await _members_out(db, note)


@router.delete("/{note_id}/members/{member_id}")
async def remove_member(
    note_id: uuid.UUID, member_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    try:
        await service.remove_member(db, user, note, member_id)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    await events.publish([member_id], events.gone_event(note.id))
    await _tell_all(db, note)
    if member_id == user.id:
        return {"left": True}
    return await _members_out(db, note)


# ------------------------------------------------------------------ reminders


@router.put("/{note_id}/reminder")
async def put_reminder(
    note_id: uuid.UUID, body: reminders.ReminderIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """Your own reminder on the note: a task in your Tasks, linked to it."""
    note = await access.load(db, user, note_id)
    try:
        await reminders.set_reminder(db, user, note, body)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    await _tell_me(user, note)
    return {"note": await service.full_out(db, user, note)}


@router.delete("/{note_id}/reminder")
async def delete_reminder(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id)
    await reminders.clear_reminder(db, user, note.id)
    await db.commit()
    await _tell_me(user, note)
    return {"note": await service.full_out(db, user, note)}


# ------------------------------------------------------------------ versions


@router.get("/{note_id}/versions")
async def versions(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id)
    rows = await service.list_versions(db, note)
    people = {v.made_by for v in rows if v.made_by}
    return {"versions": [service.version_out(v) for v in rows], "users": await service.users_map(db, people)}


@router.get("/{note_id}/versions/{version_id}")
async def version(note_id: uuid.UUID, version_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id)
    v = next((x for x in await service.list_versions(db, note) if x.id == version_id), None)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That version isn't here.")
    return {"version": service.version_out(v, full=True)}


@router.post("/{note_id}/versions/{version_id}/restore")
async def restore_version(
    note_id: uuid.UUID, version_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    try:
        await service.restore_version(db, user, note, version_id)
    except BodyError as e:
        await db.rollback()
        raise _body_error(e) from e
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    await _tell_all(db, note)
    return {"note": await service.full_out(db, user, note)}


# ------------------------------------------------------------------ attachments


@router.post("/{note_id}/attachments", status_code=status.HTTP_201_CREATED)
async def add_attachment(
    note_id: uuid.UUID, body: AttachIn, response: Response, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Put one of your own pictures or recordings in the note (uploaded with
    tus ``route=note``, or a photo from your library). A recording is
    transcribed when the server does that."""
    note = await access.load(db, user, note_id, lock=True)
    cfg = await transcription.config(db)
    att, created = await attach.add(
        db, user, note, attachment_id=body.id, file_id=body.file_id, kind=body.kind, duration_ms=body.duration_ms,
        peaks=body.peaks, transcribe=cfg.on,
    )
    if created:
        await service.touch(db, note, user)
    await db.commit()
    if created:
        await _tell_all(db, note)
        if att.kind == "audio":
            await transcription.enqueue(att.id)
    else:
        response.status_code = status.HTTP_200_OK
    return {"note": await service.full_out(db, user, note)}


@router.delete("/{note_id}/attachments/{attachment_id}")
async def remove_attachment(
    note_id: uuid.UUID, attachment_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    note = await access.load(db, user, note_id, lock=True)
    if await attach.remove(db, note, attachment_id):
        await service.touch(db, note, user)
        await db.commit()
        await _tell_all(db, note)
    return {"note": await service.full_out(db, user, note)}


@router.post("/{note_id}/attachments/{attachment_id}/transcribe")
async def retry_transcription(
    note_id: uuid.UUID, attachment_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Try a recording's words again (after "Couldn't transcribe", or one
    made while transcription was off)."""
    note = await access.load(db, user, note_id, lock=True)
    att = await attach.load(db, note, attachment_id)
    if att.kind != "audio":
        raise service.bad("Only recordings have words to find.")
    if not (await transcription.config(db)).on:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transcription is off on this server.")
    if att.transcript_state in ("pending", "working"):
        return {"note": await service.full_out(db, user, note)}
    att.transcript_state = "pending"
    note.change_seq += 1
    await db.commit()
    await _tell_all(db, note)
    await transcription.enqueue(att.id)
    return {"note": await service.full_out(db, user, note)}


# ------------------------------------------------------------------ lifecycle


@router.delete("/{note_id}")
async def delete_note(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Your note goes to Trash (collaborators lose it at once). Someone
    else's note shared with you: you leave it."""
    note = await access.load(db, user, note_id, lock=True)
    people = await access.participants(db, note)
    if note.owner_id != user.id:
        await service.remove_member(db, user, note, user.id)
        await db.commit()
        await events.publish([user.id], events.gone_event(note.id))
        await events.publish([p for p in people if p != user.id], events.note_event(note))
        return {"left": True}
    await service.trash(db, user, note)
    await db.commit()
    await events.publish([p for p in people if p != user.id], events.gone_event(note.id))
    await _tell_me(user, note)
    return {"trashed": True}


@router.post("/{note_id}/restore")
async def restore_note(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    note = await access.load(db, user, note_id, lock=True, trashed=True)
    await service.restore(db, user, note)
    await db.commit()
    await _tell_all(db, note)
    return {"note": await service.full_out(db, user, note)}


@router.delete("/{note_id}/forever")
async def delete_forever(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Owner only, from Trash or not: gone for good, for everyone."""
    try:
        note = await access.load(db, user, note_id, lock=True)
    except HTTPException:
        note = await access.load(db, user, note_id, lock=True, trashed=True)
    if note.owner_id != user.id:
        raise service.forbidden("Only the note's owner can delete it.")
    people = await access.participants(db, note)
    await service.purge(db, [note])
    await db.commit()
    await events.publish(people, events.gone_event(note_id))
    return {"deleted": True}


# ------------------------------------------------------------------ across Promptly (N1.5)


@router.post("/{note_id}/ai/{action}")
async def ai_proposal(
    note_id: uuid.UUID,
    action: Literal["tidy", "to_list", "title", "to_tasks", "to_event"],
    body: note_ai.AiIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """A proposal for the note — nothing is saved. The app shows it and,
    if the person uses it, applies it with the normal calls."""
    note = await access.load(db, user, note_id)
    return {"proposal": await note_ai.propose(db, user, note, action, body, request=request)}


@router.post("/{note_id}/copy", status_code=status.HTTP_201_CREATED)
async def copy_note(
    note_id: uuid.UUID, body: CopyIn, response: Response, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Make a copy: a new note of your own (pictures and recordings too)."""
    note = await access.load(db, user, note_id)
    try:
        copy, created = await convert.make_copy(db, user, note, body.client_id)
    except BodyError as e:
        await db.rollback()
        raise _body_error(e) from e
    except HTTPException:
        await db.rollback()
        raise
    skipped = getattr(copy, "_skipped_attachments", 0)
    await db.commit()
    if created:
        await convert.after_copy(copy)
        await _tell_me(user, copy)
    else:
        response.status_code = status.HTTP_200_OK
    return {"note": await service.full_out(db, user, copy), "skipped_attachments": skipped}


@router.post("/{note_id}/to-document", status_code=status.HTTP_201_CREATED)
async def to_document(
    note_id: uuid.UUID, body: ToDocumentIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Open as document (the owner): a Document with the note's words; the
    note shows a card that opens it and goes to your archive."""
    note = await access.load(db, user, note_id, lock=True)
    if note.doc_file_id is not None and await convert.document_card(db, user, note) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This note is already a document.")
    try:
        row = await convert.to_document(db, user, note, body.folder_id)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    await _tell_all(db, note)
    return {"note": await service.full_out(db, user, note), "document": await convert.document_card(db, user, note), "file_id": str(row.id)}


@router.delete("/{note_id}/to-document")
async def undo_to_document(note_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Undo Open as document: the document goes to Trash, the note comes back."""
    note = await access.load(db, user, note_id, lock=True)
    try:
        changed = await convert.undo_document(db, user, note)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    if changed:
        await _tell_all(db, note)
    return {"note": await service.full_out(db, user, note)}


@router.post("/{note_id}/to-tasks", status_code=status.HTTP_201_CREATED)
async def to_tasks(
    note_id: uuid.UUID, body: convert.ToTasksIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Turn into tasks: in your own Tasks, on the list you picked, linked to the note."""
    note = await access.load(db, user, note_id)
    try:
        out = await convert.to_tasks(db, user, note, body)
    except HTTPException:
        await db.rollback()
        raise
    await db.commit()
    return out


@router.post("/{note_id}/to-tasks/undo")
async def undo_to_tasks(
    note_id: uuid.UUID, body: convert.UndoTasksIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    note = await access.load(db, user, note_id)
    n = await convert.undo_tasks(db, user, note, body)
    await db.commit()
    return {"removed": n}

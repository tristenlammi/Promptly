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
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import access, events, push, service
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
    try:
        changes = await service.clean_changes(raw)
        changed = await service.patch(db, user, note, body.base_revision, changes)
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

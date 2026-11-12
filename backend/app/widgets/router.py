"""``/api/widgets`` — the phone's home-screen widgets (``docs/notes-plan.md`` §5, §9).

One small, reviewable surface. The phone signs in with its own app password
(``Authorization: Basic``) carrying the ``widgets`` scope, the same way the
map uses ``maps``; a normal session works too, for testing. A password
without ``widgets`` gets 403; a file or task that isn't yours is 404.

    GET  /widgets/snapshot?want=calendar,tasks,notes&days=7&someday=1&note=<id>…
         &calendar_etag=…&tasks_etag=…&notes_etag=…
    POST /widgets/tasks/complete  {client_id, file_id, task_id, due?, done?}
    POST /widgets/tasks           {client_id, title, due?: today|tomorrow|YYYY-MM-DD, list_id?}
    POST /widgets/notes           {client_id, kind, title?, text?, items?, files?, source?} — Quick note,
                                  Voice note, Share to Notes (client_id is the new note's id)
    POST /widgets/notes/{id}/add  {client_id, text?, files?} — Share to Notes → Add to…
    POST /widgets/notes/{id}/items        {client_id, text} — One note's + (client_id is the item's id)
    PATCH /widgets/notes/{id}/items/{iid} {client_id, checked}
    GET  /widgets/notes/pick?q=   your notes, for the One note widget's settings
    GET  /widgets/photos/albums                 the albums the Photo widget can show (photos.py)
    GET  /widgets/photos/albums/{id}?n=&have=…  a few of its photos at random, with signed links
    GET  /widgets/glance?want=counts,today,…   the other widgets' numbers in one call (glance.py)
    GET  /widgets/people?q=                     people for the Favourite people widget
    GET  /widgets/briefing                      "Read me my day" for the Today widget

Pictures and recordings come up first through tus (``route=note``, with the
phone's ``upload`` scope) and are attached here by their file id.

Every write carries a ``client_id`` (one per change, made on the phone).
The answer is kept for a day under ``promptly:widget-op:<user>:<client_id>``,
so the phone's outbox can send the same change again — after a lost answer,
a reboot — and it's done once.
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.basic import client_ip, user_from_basic
from app.auth.deps import _bearer, get_current_user
from app.auth.models import User
from app.database import get_db

from . import snapshot

router = APIRouter()

SCOPE = "widgets"
OP_SECONDS = 24 * 60 * 60
_PENDING = "pending"


async def widget_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """The phone's app password (scope ``widgets``), or the signed-in person."""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        return await user_from_basic(db, header, scope=SCOPE, ip=client_ip(request))
    return await get_current_user(request, credentials, db)


# ------------------------------------------------------------------ snapshot


@router.get("/snapshot")
async def get_snapshot(
    want: str = Query("calendar,tasks", max_length=60),
    days: int = Query(7, ge=1, le=snapshot.MAX_DAYS),
    someday: bool = False,
    note: list[uuid.UUID] = Query(default_factory=list),
    calendar_etag: str | None = Query(None, max_length=64),
    tasks_etag: str | None = Query(None, max_length=64),
    notes_etag: str | None = Query(None, max_length=64),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(widget_user),
) -> dict[str, Any]:
    wanted = [w for w in dict.fromkeys(x.strip() for x in want.split(",")) if w in snapshot.SECTIONS]
    if not wanted:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ask for calendar, tasks or notes.")
    have = {k: v for k, v in (("calendar", calendar_etag), ("tasks", tasks_etag), ("notes", notes_etag)) if v}
    return await snapshot.build(
        db, user, want=wanted, days=days, someday=someday, note_ids=list(dict.fromkeys(note))[: snapshot.MAX_NOTE_IDS], have=have
    )


# ------------------------------------------------------------------ safe replays


def _op_key(user: User, client_id: uuid.UUID) -> str:
    return f"promptly:widget-op:{user.id}:{client_id}"


async def _replayed(user: User, client_id: uuid.UUID) -> dict[str, Any] | None:
    """The answer already given for this change, or None after claiming it.
    A change still being made (a double send) is 409: try again shortly."""
    from app.redis_client import redis

    key = _op_key(user, client_id)
    if await redis.set(key, _PENDING, ex=60, nx=True):
        return None
    raw = await redis.get(key)
    if raw is None or raw == _PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "That change is still being saved. Try again in a moment.")
    return {**json.loads(raw), "replayed": True}


async def _remember(user: User, client_id: uuid.UUID, answer: dict[str, Any]) -> None:
    from app.redis_client import redis

    await redis.set(_op_key(user, client_id), json.dumps(answer), ex=OP_SECONDS)


async def _forget(user: User, client_id: uuid.UUID) -> None:
    from app.redis_client import redis

    await redis.delete(_op_key(user, client_id))


def _gone(what: str = "That task isn't there any more.") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, what)


# ------------------------------------------------------------------ tasks


class CompleteBody(BaseModel):
    client_id: uuid.UUID
    file_id: uuid.UUID
    task_id: str = Field(min_length=1, max_length=64)
    # The day the widget showed it due: a repeating task already moved on
    # past it (ticked somewhere else) isn't ticked a second time.
    due: date | None = None
    done: bool = True


@router.post("/tasks/complete")
async def complete_task(body: CompleteBody, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    from app.items import service as items
    from app.items.registry import get_spec
    from app.items.spec import ActionError

    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        try:
            row, doc, _access = await items.load(db, user, body.file_id, need="edit", lock=True)
        except items.ItemNotFound:
            raise _gone() from None
        spec = get_spec(doc.kind)
        if spec is None or doc.kind != "tasks":
            raise _gone()
        await items.upgrade(db, doc)
        data = copy.deepcopy(doc.data)
        task = next((t for t in data.get("tasks", []) if t.get("id") == body.task_id), None)
        if task is None:
            raise _gone()
        due = body.due.isoformat() if body.due else None
        if body.done and (task.get("done") or (due and task.get("due") and task["due"] != due and task.get("repeat"))):
            answer = {"ok": True, "result": "already", "task": {"id": task["id"], "done": bool(task.get("done")), "due": task.get("due")}}
        elif not body.done and not task.get("done"):
            answer = {"ok": True, "result": "already", "task": {"id": task["id"], "done": False, "due": task.get("due")}}
        else:
            ctx = items.make_context(db, user, row.id, spec)
            try:
                out = await items.run_action(ctx, spec, data, "complete_tasks", {"tasks": [task["id"]], "done": body.done})
                await items.save_data(db, user, row, doc, data, base_revision=None)
            except (ActionError, items.ItemError) as exc:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            await db.commit()
            now = next(t for t in data["tasks"] if t["id"] == task["id"])
            answer = {"ok": True, "result": out.summary, "task": {"id": now["id"], "done": bool(now.get("done")), "due": now.get("due")}}
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    return answer


class AddBody(BaseModel):
    client_id: uuid.UUID
    title: str = Field(min_length=1, max_length=500)
    # "today" / "tomorrow" in your Promptly time zone, or the day the phone
    # meant (it sends the day it was added on, so a task queued at 11 pm
    # with no signal isn't due a day late).
    due: str | None = Field(default=None, max_length=10)
    list_id: str | None = Field(default=None, max_length=64)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Give the task a name.")
        return v

    @field_validator("due")
    @classmethod
    def _due(cls, v: str | None) -> str | None:
        if v in (None, "", "none"):
            return None
        if v in ("today", "tomorrow"):
            return v
        try:
            return date.fromisoformat(v).isoformat()
        except ValueError:
            raise ValueError("due is today, tomorrow or a date (YYYY-MM-DD).") from None


def _due_day(due: str | None, user: User) -> date | None:
    from app.items.service import zone_for

    if due is None:
        return None
    if due in ("today", "tomorrow"):
        today = datetime.now(timezone.utc).astimezone(zone_for(user)).date()
        return today + timedelta(days=1 if due == "tomorrow" else 0)
    return date.fromisoformat(due)


@router.post("/tasks", status_code=status.HTTP_201_CREATED)
async def add_task(body: AddBody, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    from app.items import service as items
    from app.items.registry import get_spec
    from app.items.spec import ActionError

    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        row, _made = await items.open_app(db, user, "tasks")
        row, doc, _access = await items.load(db, user, row.id, need="edit", lock=True)
        spec = get_spec("tasks")
        await items.upgrade(db, doc)
        data = copy.deepcopy(doc.data)
        lst = None
        if body.list_id and body.list_id != "inbox":
            lst = next((x for x in data.get("lists", []) if x.get("id") == body.list_id), None)
        due = _due_day(body.due, user)
        ctx = items.make_context(db, user, row.id, spec)
        try:
            out = await items.run_action(
                ctx, spec, data, "add_tasks",
                {"tasks": [{"title": body.title, "due": due.isoformat() if due else None, "list": lst["name"] if lst else None}]},
            )
            await items.save_data(db, user, row, doc, data, base_revision=None)
        except (ActionError, items.ItemError) as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        await db.commit()
        made = out.result[0]
        task = next(t for t in data["tasks"] if t["id"] == made["id"])
        answer = {
            "ok": True,
            "file_id": str(row.id),
            "task": {"id": task["id"], "title": task["title"], "due": task.get("due"), "time": task.get("time"), "list_id": task.get("list_id", "inbox"), "priority": task.get("priority", 0), "repeats": bool(task.get("repeat"))},
        }
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    return answer


# ------------------------------------------------------------------ notes (W1.3)


class FileIn(BaseModel):
    """A picture or recording the phone uploaded (tus ``route=note``)."""

    id: uuid.UUID  # the attachment's id, made on the phone
    file_id: uuid.UUID
    duration_ms: int | None = Field(default=None, ge=0)
    peaks: list[float] | None = Field(default=None, max_length=200)


class NoteNew(BaseModel):
    client_id: uuid.UUID
    kind: Literal["text", "list"] = "text"
    title: str = Field(default="", max_length=300)
    text: str | None = Field(default=None, max_length=20_000)
    items: list[str] = Field(default_factory=list, max_length=1000)
    files: list[FileIn] = Field(default_factory=list, max_length=20)
    source: Literal["android", "voice", "share"] = "android"

    @field_validator("items")
    @classmethod
    def _items(cls, v: list[str]) -> list[str]:
        return [" ".join(x.split())[:1000] for x in v if x and x.strip()]


class NoteMore(BaseModel):
    client_id: uuid.UUID
    text: str | None = Field(default=None, max_length=20_000)
    files: list[FileIn] = Field(default_factory=list, max_length=20)


class ItemNew(BaseModel):
    client_id: uuid.UUID  # the item's id
    text: str = Field(min_length=1, max_length=1000)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Type the item first.")
        return v


class ItemTick(BaseModel):
    client_id: uuid.UUID
    checked: bool


_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


def _lines(text: str) -> list[str]:
    return [ln.strip()[:1000] for ln in text.replace("\r", "\n").split("\n") if ln.strip()]


async def _page_title(text: str | None) -> str:
    """Shared text with a link in it and no title from the app: the page's
    own title, fetched through the SSRF-safe fetcher (``safe_fetch``, as
    link previews do). "" if there's none."""
    from urllib.parse import urlparse

    if not text:
        return ""
    m = _URL.search(text)
    if not m:
        return ""
    url = m.group(0).rstrip(".,;:!?)]}")
    from app.files.links_router import unfurl

    try:
        preview = await unfurl(url=url, user=None)  # type: ignore[arg-type] — the route doesn't use the user
    except Exception:  # noqa: BLE001 — a title is a nicety
        return ""
    title = " ".join((preview.title or "").split())
    return "" if not title or title == urlparse(url).netloc else title[:300]


async def _attach_files(db: AsyncSession, user: User, note: Any, files: list[FileIn]) -> list[uuid.UUID]:
    """Put the phone's uploads in the note. Returns the recordings to
    transcribe. A file that isn't yours (or is gone) is 404 for the lot."""
    from app.notes import attachments as attach
    from app.notes import transcription

    if not files:
        return []
    cfg = await transcription.config(db)
    audio: list[uuid.UUID] = []
    for f in files:
        att, created = await attach.add(
            db, user, note, attachment_id=f.id, file_id=f.file_id, duration_ms=f.duration_ms, peaks=f.peaks, transcribe=cfg.on,
        )
        if created and att.kind == "audio" and cfg.on:
            audio.append(att.id)
    return audio


async def _after_note_change(db: AsyncSession, note: Any, audio: list[uuid.UUID]) -> None:
    """After commit: the people on the note refetch it; recordings queue for their words."""
    from app.notes import access, events, transcription

    await events.publish(await access.participants(db, note), events.note_event(note))
    for aid in audio:
        await transcription.enqueue(aid)


@router.post("/notes", status_code=status.HTTP_201_CREATED)
async def new_note(body: NoteNew, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    """Quick note, Voice note and Share to Notes: a new note of yours, with
    its pictures or recording. ``client_id`` is the note's id. Safe to send twice."""
    from app.notes import service
    from app.notes.body import BodyError

    if not (body.title.strip() or (body.text or "").strip() or body.items or body.files):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "There's nothing in the note to save.")
    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        title = " ".join(body.title.split())[:300]
        if not title and body.source == "share":
            title = await _page_title(body.text)
        items = [{"text": t} for t in body.items]
        text = body.text
        if body.kind == "list" and not items and text:
            items, text = [{"text": ln} for ln in _lines(text)], None
        try:
            note, _created = await service.create(
                db, user, note_id=body.client_id, kind=body.kind, title=title, text=text if body.kind == "text" else None,
                items=items if body.kind == "list" else [], source=body.source,
            )
            audio = await _attach_files(db, user, note, body.files)
            if audio or body.files:
                await service.touch(db, note, user)
        except BodyError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        answer = {"ok": True, "note_id": str(note.id), **await snapshot.note_views(db, user, note)}
        await db.commit()
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    await _after_note_change(db, note, audio)
    return answer


@router.post("/notes/{note_id}/add")
async def add_to_note(note_id: uuid.UUID, body: NoteMore, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    """Share to Notes → Add to…: text goes under what's there (a list gets
    a new item for each line); pictures and recordings are attached."""
    from app.notes import access, service
    from app.notes import body as B

    text = (body.text or "").strip()
    if not text and not body.files:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "There's nothing to add.")
    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        note = await access.load(db, user, note_id, lock=True)
        if text:
            if note.kind == "list":
                for i, ln in enumerate(_lines(text)):
                    # Ids from the change's own id: a retry adds nothing twice.
                    await service.add_item(db, user, note, item_id=uuid.uuid5(body.client_id, str(i)), text=ln)
            else:
                extra = (B.text_doc(text) or {}).get("content") or []
                doc = {"type": "doc", "content": [*((note.body_doc or {}).get("content") or []), *extra]}
                try:
                    B.checked_text(B.doc_text(doc))
                    await service.patch(db, user, note, note.revision, {"body_doc": B.clean_doc(doc)})
                except B.BodyError as exc:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        audio = await _attach_files(db, user, note, body.files)
        if body.files:
            await service.touch(db, note, user)
        answer = {"ok": True, "note_id": str(note.id), **await snapshot.note_views(db, user, note)}
        await db.commit()
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    await _after_note_change(db, note, audio)
    return answer


@router.post("/notes/{note_id}/items", status_code=status.HTTP_201_CREATED)
async def add_note_item(note_id: uuid.UUID, body: ItemNew, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    """The One note widget's **+**: an item at the end of the list.
    ``client_id`` is the item's id."""
    from app.notes import access, service

    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        note = await access.load(db, user, note_id, lock=True)
        if note.kind != "list":
            raise HTTPException(status.HTTP_409_CONFLICT, "That note isn't a list any more.")
        await service.add_item(db, user, note, item_id=body.client_id, text=body.text)
        answer = {"ok": True, "note_id": str(note.id), **await snapshot.note_views(db, user, note)}
        await db.commit()
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    await _after_note_change(db, note, [])
    return answer


@router.patch("/notes/{note_id}/items/{item_id}")
async def tick_note_item(
    note_id: uuid.UUID, item_id: uuid.UUID, body: ItemTick, db: AsyncSession = Depends(get_db), user: User = Depends(widget_user),
) -> dict[str, Any]:
    """Tick (or untick) a list item on a widget. Ticking one that's already
    ticked changes nothing."""
    from app.notes import access, service

    if (prior := await _replayed(user, body.client_id)) is not None:
        return prior
    try:
        note = await access.load(db, user, note_id, lock=True)
        if note.kind != "list":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That item isn't there any more.")
        _item, changed = await service.update_item(db, user, note, item_id, {"checked": body.checked})
        answer = {"ok": True, "note_id": str(note.id), **await snapshot.note_views(db, user, note)}
        await db.commit()
    except BaseException:
        await _forget(user, body.client_id)
        raise
    await _remember(user, body.client_id, answer)
    if changed:
        await _after_note_change(db, note, [])
    return answer


@router.get("/notes/pick")
async def pick_note(
    q: str | None = Query(None, max_length=200), db: AsyncSession = Depends(get_db), user: User = Depends(widget_user),
) -> dict[str, Any]:
    """Your notes for the One note widget's settings: pinned first, then the
    most recently changed; ``q`` narrows by title and words."""
    from sqlalchemy import and_, case, func, literal_column, or_, select

    from app.files.search_query import drive_tsquery
    from app.notes import access
    from app.notes.models import Note, NoteItem, NoteUserState
    from app.notes.service import display_title

    st = NoteUserState
    stmt = (
        select(Note, st.pinned)
        .outerjoin(st, and_(st.note_id == Note.id, st.user_id == user.id))
        .where(access.visible_predicate(user.id), st.archived_at.is_(None))
    )
    if q and q.strip():
        term = q.strip()[:200]
        pat = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(literal_column("notes.tsv").op("@@")(drive_tsquery(term)), Note.title.ilike(pat, escape="\\")))
    rank = case((func.coalesce(st.pinned, False), 0), else_=1)
    rows = (await db.execute(stmt.order_by(rank, Note.updated_at.desc(), Note.id).limit(40))).all()
    left: dict[uuid.UUID, int] = {}
    lists = [n.id for n, _ in rows if n.kind == "list"]
    if lists:
        counted = select(NoteItem.note_id, func.count()).where(NoteItem.note_id.in_(lists), NoteItem.checked.is_(False)).group_by(NoteItem.note_id)
        left = {nid: cnt for nid, cnt in (await db.execute(counted)).all()}
    # A recording on its own is "Voice note", as on the widget's cards.
    bare = [n.id for n, _ in rows if n.kind == "text" and not n.title.strip() and not (n.body_text or "").strip()]
    voiced = await snapshot._voiced(db, bare)
    return {
        "notes": [
            {
                "id": str(n.id), "kind": n.kind, "title": "Voice note" if n.id in voiced else display_title(n), "color": n.color, "pinned": bool(p),
                "shared": n.owner_id != user.id, "left": left.get(n.id, 0) if n.kind == "list" else None,
            }
            for n, p in rows
        ]
    }


# ------------------------------------------------------------------ photos


@router.get("/photos/albums")
async def photo_albums(db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    """The albums the Photo widget can show: yours and the ones shared with you."""
    from . import photos

    return {"albums": await photos.albums(db, user)}


@router.get("/photos/albums/{album_id}")
async def photo_album_pick(
    album_id: uuid.UUID,
    n: int = Query(6, ge=1, le=12),
    have: list[uuid.UUID] = Query(default_factory=list),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(widget_user),
) -> dict[str, Any]:
    """A few of the album's photos at random (no videos), with links to them.
    ``have``: the ones the phone holds already — others come first."""
    from . import photos

    out = await photos.pick(db, user, album_id, n, list(dict.fromkeys(have)))
    if out is None:
        raise _gone("That album isn't there any more.")
    return out


__all__ = ["router", "widget_user"]


# ------------------------------------------------------------------ at a glance


@router.get("/glance")
async def get_glance(
    want: str = Query("counts", max_length=120),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(widget_user),
) -> dict[str, Any]:
    """The other widgets' numbers in one call (``glance.py``): ``counts``
    (the app panel's badges), ``today``, ``macros``, ``social`` (Rooms and
    Porch), ``maps``, ``trips`` (who's on their way), ``health``, ``mail``."""
    from . import glance

    wanted = [w for w in dict.fromkeys(x.strip() for x in want.split(",")) if w in glance.SECTIONS]
    if not wanted:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ask for one of: " + ", ".join(glance.SECTIONS) + ".")
    out = await glance.build(db, user, wanted)
    # Nothing here is written; drop the read transaction.
    await db.rollback()
    return out


@router.get("/people")
async def pick_people(q: str = Query("", max_length=80), db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    """People for the Favourite people widget's settings: names only."""
    from . import glance

    out = {"people": await glance.people(db, user, q.strip())}
    await db.rollback()
    return out


@router.get("/briefing")
async def briefing(db: AsyncSession = Depends(get_db), user: User = Depends(widget_user)) -> dict[str, Any]:
    """The Today widget's "Read me my day": the same script Today reads out
    (``today/briefing.py``, no model call). The phone speaks it."""
    from app.today import briefing as b

    out = await b.build(db, user)
    await db.rollback()
    return out

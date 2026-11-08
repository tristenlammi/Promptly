"""What a thing is, and how it looks to someone.

A thing is named by ``(kind, id)``. Things that live inside an app file
(a task in your Tasks file …) are ``<file id>:<id inside it>``:

==========  =====================================  =========================
kind        id                                     who can see it
==========  =====================================  =========================
file        Drive file id (docs, sheets, uploads)  Drive: owner, grants, workspace
folder      Drive folder id                        owner or a grant
photo       the photo's file id                    as ``file``
album       album id                               owner or album member
task        tasks file : task id                   whoever can open the app file
recipe      mealplan file : recipe id              ″
trip        trip file : trip id                    ″
contact     contacts file : contact id             ″
txn         budget file : transaction id           ″
journal     journal file : entry id                ″
event       calendar event id                      calendar member / guest (not free/busy-only)
person      Photos person id                       the Photos library's owner
user        account id                             anyone signed in (not disabled)
witem       workspace item id                      workspace member (private drafts: author)
room_msg    room message id                        people in the room
chat_msg    chat message id                        the chat's owner (or workspace, if shared)
porch_post  Porch post id                           who can see it in Porch (``porch.access``)
==========  =====================================  =========================

:func:`resolve` answers the thing as ``user`` sees it, or None when they
can't see it — or it's gone. Every check is the app's own; nothing here
grants anything, and None never says *why*.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

# The app file a sub-thing lives in, by kind.
IN_ITEM: dict[str, str] = {
    "task": "tasks",
    "recipe": "mealplan",
    "trip": "trip",
    "contact": "contacts",
    "txn": "budget",
    "journal": "journal",
}
UUID_KINDS = ("file", "folder", "photo", "album", "event", "person", "user", "witem", "room_msg", "chat_msg")
# Porch (WP-P1.6): a post, as the people who can see it see it.
UUID_KINDS = (*UUID_KINDS, "porch_post")
KINDS: tuple[str, ...] = (*UUID_KINDS, *IN_ITEM)
# Kinds whose text can mention things (the "Mentioned in" side).
SOURCE_KINDS = ("file", "room_msg", "chat_msg", "journal")

LABELS = {
    "file": "File", "folder": "Folder", "photo": "Photo", "album": "Album", "task": "Task", "recipe": "Recipe",
    "trip": "Trip", "contact": "Contact", "txn": "Transaction", "journal": "Journal entry", "event": "Event",
    "person": "Person", "user": "Person", "witem": "Workspace item", "room_msg": "Message", "chat_msg": "Chat",
    "porch_post": "Porch post",
}

_SUB_RE = re.compile(r"^[A-Za-z0-9_\-]{1,60}$")


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v))
    except (TypeError, ValueError):
        return None


def valid(kind: str, id_: str) -> bool:
    """Is ``(kind, id)`` well formed? (Says nothing about whether it exists.)"""
    if kind in UUID_KINDS:
        return _uuid(id_) is not None
    if kind in IN_ITEM:
        fid, _, sub = (id_ or "").partition(":")
        return _uuid(fid) is not None and bool(_SUB_RE.match(sub))
    return False


def normalise(kind: str, id_: str) -> str:
    """The one spelling of an id (lower-case uuids), so a pair is stored once."""
    if kind in UUID_KINDS:
        return str(uuid.UUID(str(id_)))
    fid, _, sub = id_.partition(":")
    return f"{uuid.UUID(fid)}:{sub}"


def store_kind(kind: str) -> str:
    """How a kind is stored: a photo *is* its file, so links and mentions
    made from Photos and from Drive land on the same row."""
    return "file" if kind == "photo" else kind


def _snip(text: str, n: int = 120) -> str:
    text = re.sub(r"@\[([^\]\n]+?)\]\([^)\s]+\)", r"\1", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= n else text[: n - 1] + "…"


# ------------------------------------------------------------------ resolvers


async def _app_data(db: AsyncSession, user: User, id_: str, app: str) -> tuple[uuid.UUID, str, dict] | None:
    from app.items import service as items

    fid_s, _, sub = id_.partition(":")
    fid = _uuid(fid_s)
    if fid is None or not sub:
        return None
    try:
        row, doc, _access = await items.load(db, user, fid)
    except items.ItemNotFound:
        return None
    if doc.kind != app or row.trashed_at is not None:
        return None
    return fid, sub, doc.data or {}


async def _in_item(db: AsyncSession, user: User, kind: str, id_: str) -> dict | None:
    from app.crossapp import shares

    if kind in ("task", "recipe", "trip"):
        fid, _, sub = id_.partition(":")
        got = await shares.card(db, user, {"kind": kind, "id": sub, "file_id": fid})
        if got is None:
            return None
        out = {k: got.get(k) for k in ("title", "subtitle", "href", "thumb", "emoji", "image_url")}
        if kind == "task":
            out["href"] = f"/apps/tasks/{fid}?task={sub}"
        return out
    found = await _app_data(db, user, id_, IN_ITEM[kind])
    if found is None:
        return None
    fid, sub, data = found
    if kind == "contact":
        from app.items.kinds.contacts.logic import display_name

        c = next((x for x in data.get("contacts", []) if x.get("id") == sub), None)
        if c is None:
            return None
        bits = [x for x in (c.get("company") or "", c.get("title") or "") if x]
        return {"title": display_name(c) or "Contact", "subtitle": " · ".join(["Contact", *bits]), "href": f"/apps/contacts/{fid}?c={sub}"}
    if kind == "txn":
        t = next((x for x in data.get("transactions", []) if x.get("id") == sub), None)
        if t is None:
            return None
        cents = int(t.get("amount_cents") or 0)
        amount = f"{'-' if cents < 0 else ''}{abs(cents) / 100:,.2f}"
        return {
            "title": t.get("payee") or t.get("description") or "Transaction",
            "subtitle": f"Transaction · {shares._day_text(t.get('date'))} · {amount}",
            "href": f"/apps/budget/{fid}?tab=transactions&txn={sub}",
        }
    # journal
    e = next((x for x in data.get("entries", []) if x.get("id") == sub), None)
    if e is None:
        return None
    return {
        "title": e.get("title") or f"Journal · {shares._day_text(e.get('date'))}",
        "subtitle": "Journal entry · " + (_snip(e.get("body") or "", 80) or shares._day_text(e.get("date"))),
        "href": f"/apps/journal/{fid}?entry={sub}",
    }


async def _event(db: AsyncSession, user: User, eid: uuid.UUID) -> dict | None:
    from app.calendars import core

    try:
        ev, m, att = await core.load_event(db, eid, user)
    except HTTPException:
        return None
    if core.busy_only(m, att):
        # Free/busy only: the title is exactly what mustn't show.
        return None
    when = ev.start_at.date().isoformat() if ev.start_at else None
    from app.crossapp.shares import _day_text

    return {"title": ev.title or "Event", "subtitle": "Event" + (f" · {_day_text(when)}" if when else ""), "href": f"/calendar?event={ev.id}"}


async def _person(db: AsyncSession, user: User, pid: uuid.UUID) -> dict | None:
    from app.people.directory import photo_people
    from app.people.router import _crop

    rows = await photo_people(db, user, "p.id = :pid", pid=pid)
    if not rows:
        return None
    r = rows[0]
    return {"title": r.name or "Someone", "subtitle": "Person" + (f" · {r.label}" if r.label else ""), "thumb": _crop(r.cover, user), "href": f"/people/p/{pid}"}


async def _user(db: AsyncSession, user: User, uid: uuid.UUID) -> dict | None:
    u = await db.get(User, uid)
    if u is None or u.disabled:
        return None
    return {"title": u.username, "subtitle": "Person", "href": f"/people/u/{uid}"}


async def _witem(db: AsyncSession, user: User, iid: uuid.UUID) -> dict | None:
    from app.chat.models import WorkspaceItem
    from app.workspaces.shares import get_accessible_workspace
    from app.workspaces.visibility import item_visible_to

    item = (
        await db.execute(select(WorkspaceItem).where(WorkspaceItem.id == iid, item_visible_to(user.id)))
    ).scalar_one_or_none()
    if item is None or item.trashed_at is not None:
        return None
    try:
        ws, _role = await get_accessible_workspace(item.workspace_id, user, db)
    except HTTPException:
        return None
    href = f"/workspaces/{ws.id}?item={item.id}&kind={item.kind}" + (f"&ref={item.ref_id}" if item.ref_id else "")
    return {"title": item.title or "Untitled", "subtitle": f"{(item.kind or 'item').capitalize()} · {ws.title}", "href": href}


async def _room_msg(db: AsyncSession, user: User, mid: uuid.UUID) -> dict | None:
    from app.rooms import core as rooms_core
    from app.rooms.models import RoomMessage

    msg = await db.get(RoomMessage, mid)
    if msg is None or msg.deleted_at is not None:
        return None
    try:
        room, _sm = await rooms_core.load_room(db, msg.room_id, user)
    except HTTPException:
        return None
    if room.space_id is not None and room.name:
        where = f"#{room.name}"
    else:
        where = "Direct message" if room.kind == "dm" else (room.name or "Group")
    author = await db.get(User, msg.author_id) if msg.author_id else None
    return {
        "title": f"Message in {where}",
        "subtitle": (f"{author.username}: " if author else "") + _snip(msg.body),
        "href": f"/rooms/r/{room.id}?m={msg.seq}",
    }


async def _chat_msg(db: AsyncSession, user: User, mid: uuid.UUID) -> dict | None:
    from app.chat.models import Message
    from app.chat.shares import get_accessible_conversation

    msg = await db.get(Message, mid)
    if msg is None:
        return None
    try:
        conv, _role = await get_accessible_conversation(msg.conversation_id, user, db)
    except HTTPException:
        return None
    return {"title": conv.title or "Chat", "subtitle": "Chat · " + _snip(msg.content if isinstance(msg.content, str) else ""), "href": f"/chat/{conv.id}"}


async def resolve(db: AsyncSession, user: User, kind: str, id_: str) -> dict | None:
    """``{kind, id, label, title, subtitle, href, thumb, emoji, image_url}`` as
    ``user`` sees the thing, or None when they can't (or it's gone)."""
    if kind not in KINDS or not valid(kind, id_):
        return None
    try:
        out: dict | None
        if kind in IN_ITEM:
            out = await _in_item(db, user, kind, id_)
        else:
            oid = uuid.UUID(id_)
            if kind in ("file", "photo", "folder", "album"):
                from app.crossapp import shares

                got = await shares.card(db, user, {"kind": kind, "id": str(oid)})
                out = None if got is None else {k: got.get(k) for k in ("title", "subtitle", "href", "thumb", "emoji", "image_url")}
                if out is not None and not out.get("href"):
                    out["href"] = f"/files/f/{oid}"
            elif kind == "event":
                out = await _event(db, user, oid)
            elif kind == "person":
                out = await _person(db, user, oid)
            elif kind == "user":
                out = await _user(db, user, oid)
            elif kind == "witem":
                out = await _witem(db, user, oid)
            elif kind == "room_msg":
                out = await _room_msg(db, user, oid)
            elif kind == "porch_post":
                from app.porch.handoffs import card as porch_card

                out = await porch_card(db, user, oid)
            else:
                out = await _chat_msg(db, user, oid)
    except HTTPException:
        return None
    if out is None:
        return None
    return {
        "kind": kind,
        "id": id_,
        "label": LABELS[kind],
        "thumb": None,
        "emoji": None,
        "image_url": None,
        **out,
    }

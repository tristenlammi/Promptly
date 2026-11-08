"""The person page and the people picker.

    GET /api/people/u/{user_id}                   a Promptly account
    GET /api/people/c/{file_id}/{contact_id}      a contact (in a Contacts file you can read)
    GET /api/people/p/{person_id}                 one of your Photos people
    GET /api/people/search?q=                     the people picker: accounts, your contacts and faces

All three page addresses resolve to the same merged person and the same
answer. Everything is the viewer's view: their contacts and Photos people,
events they can see, rooms they're in, files shared between the two of them.
Message text is never included — only which rooms you share.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, select, union
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from .directory import Person, complete, directory, photo_people

router = APIRouter()

EVENT_DAYS = 90
MAX_EVENTS = 6
MAX_ROOMS = 12
MAX_FILES = 12
MAX_PHOTOS = 12
MAX_RESULTS = 30


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Person not found")


def _crop(obs_id: uuid.UUID | None, viewer: User) -> str | None:
    from app.photos.people_router import _crop as crop

    return crop(obs_id, viewer)


def _user_out(u: User) -> dict:
    from app.rooms.core import user_out

    return user_out(u)


# ------------------------------------------------------------------ resolve


async def _by_user(db: AsyncSession, viewer: User, user_id: uuid.UUID) -> Person:
    u = await db.get(User, user_id)
    if u is None or u.disabled:
        raise _not_found()
    return await complete(db, viewer, Person(user=u, match="me" if u.id == viewer.id else None))


async def _by_contact(db: AsyncSession, viewer: User, file_id: uuid.UUID, contact_id: str) -> Person:
    from app.items import service as items

    try:
        _row, doc, _access = await items.load(db, viewer, file_id)
    except items.ItemNotFound:
        raise _not_found()
    c = next((c for c in (doc.data or {}).get("contacts", []) if c.get("id") == contact_id), None) if doc.kind == "contacts" else None
    if c is None:
        raise _not_found()
    return await complete(db, viewer, Person(file_id=file_id, contact=c))


async def _by_photo_person(db: AsyncSession, viewer: User, person_id: uuid.UUID) -> Person:
    from app.items import service as items

    rows = await photo_people(db, viewer, "p.id = :pid", pid=person_id)
    if not rows:
        raise _not_found()
    r = rows[0]
    p = Person(person_id=r.id, person_name=r.name, cover=r.cover, label=r.label or None)
    if r.contact_file_id and r.contact_id:
        try:
            _row, doc, _access = await items.load(db, viewer, r.contact_file_id)
            p.contact = next((c for c in (doc.data or {}).get("contacts", []) if c.get("id") == r.contact_id), None)
            p.file_id = r.contact_file_id if p.contact else None
        except items.ItemNotFound:
            pass
    if r.linked_user_id:
        u = await db.get(User, r.linked_user_id)
        if u is not None and not u.disabled:
            p.user, p.match = u, "me" if u.id == viewer.id else None
    return await complete(db, viewer, p)


# ------------------------------------------------------------------ sections


def _contact_out(db_file_id: uuid.UUID, c: dict, can_edit: bool) -> dict:
    return {
        "file_id": str(db_file_id),
        "contact_id": c.get("id"),
        "name": None,
        "nickname": c.get("nickname") or "",
        "company": c.get("company") or "",
        "title": c.get("title") or "",
        "phones": [{"label": x.get("label") or "", "value": x.get("value") or ""} for x in c.get("phones", []) if x.get("value")],
        "emails": [{"label": x.get("label") or "", "value": x.get("value") or ""} for x in c.get("emails", []) if x.get("value")],
        "addresses": [
            {k: a.get(k) or "" for k in ("label", "street", "city", "region", "postcode", "country")} for a in c.get("addresses", [])
        ],
        "websites": [{"label": x.get("label") or "", "value": x.get("value") or ""} for x in c.get("websites", []) if x.get("value")],
        "birthday": c.get("birthday") or None,
        "dates": [{"label": d.get("label") or "", "date": d.get("date"), "kind": d.get("kind") or "other"} for d in c.get("dates", []) if d.get("date")],
        "photo": c.get("photo") or None,
        "can_edit": can_edit,
    }


async def _photos(db: AsyncSession, viewer: User, person_id: uuid.UUID) -> dict | None:
    from app.photos.people_router import get_person

    try:
        got = await get_person(person_id, before=None, limit=MAX_PHOTOS, db=db, user=viewer)
    except HTTPException:
        return None
    return {"person_id": str(person_id), "count": int(got["person"].get("photos") or 0), "items": got["items"]}


async def _events(db: AsyncSession, viewer: User, target: User) -> list[dict]:
    """Coming up with them: events you can see (not free/busy-only ones)
    that they organise or are a guest at and haven't declined."""
    from app.calendars import core

    start = core.now()
    end = start + timedelta(days=EVENT_DAYS)
    occ = await core.occurrences_out(db, viewer, await core.visible_events(db, viewer, start, end), start, end)
    tid = str(target.id)
    out = []
    for o in occ:
        if o.get("busy_only"):
            continue
        theirs = o.get("created_by") == tid or any(a["user_id"] == tid and a["status"] != "declined" for a in o.get("attendees", []))
        if not theirs:
            continue
        out.append({k: o.get(k) for k in ("id", "event_id", "title", "start", "end", "all_day", "location", "color", "my_status")})
        if len(out) >= MAX_EVENTS:
            break
    return out


async def _rooms(db: AsyncSession, viewer: User, target: User) -> tuple[str | None, list[dict]]:
    """Your 1:1 conversation with them, and the other rooms you're both in
    (names only — never what was said)."""
    from app.rooms.core import visible_room_ids
    from app.rooms.models import Room, RoomMember, RoomSpace

    mine = select(RoomMember.room_id).where(RoomMember.user_id == viewer.id)
    theirs = select(RoomMember.room_id).where(RoomMember.user_id == target.id)
    dm = (
        await db.execute(select(Room.id).where(Room.space_id.is_(None), Room.kind == "dm", Room.id.in_(mine), Room.id.in_(theirs)).limit(1))
    ).scalar_one_or_none()
    both = (set(await visible_room_ids(db, viewer.id)) & set(await visible_room_ids(db, target.id))) - ({dm} if dm else set())
    out: list[dict] = []
    if both:
        rows = (
            await db.execute(
                select(Room, RoomSpace)
                .outerjoin(RoomSpace, RoomSpace.id == Room.space_id)
                .where(Room.id.in_(both))
                .order_by(Room.last_message_at.desc().nulls_last())
                .limit(MAX_ROOMS)
            )
        ).all()
        for room, space in rows:
            if room.space_id is None:
                name = room.name or "Group chat"
            else:
                name = f"#{room.name}" + (f" · {space.name}" if space else "")
            out.append({"room_id": str(room.id), "name": name, "space": space.name if space else None, "kind": room.kind})
    return (str(dm) if dm else None), out


async def _files(db: AsyncSession, viewer: User, target: User) -> list[dict]:
    """Files and folders one of you shared straight with the other."""
    from app.files.models import FileFolder, ResourceGrant, UserFile

    grants = (
        await db.execute(
            select(ResourceGrant)
            .where(
                ResourceGrant.via_link_id.is_(None),
                or_(
                    and_(ResourceGrant.granted_by_user_id == viewer.id, ResourceGrant.grantee_user_id == target.id),
                    and_(ResourceGrant.granted_by_user_id == target.id, ResourceGrant.grantee_user_id == viewer.id),
                ),
            )
            .order_by(ResourceGrant.created_at.desc())
            .limit(60)
        )
    ).scalars().all()
    file_ids = [g.resource_id for g in grants if g.resource_type == "file"]
    folder_ids = [g.resource_id for g in grants if g.resource_type == "folder"]
    files = {
        f.id: f
        for f in (await db.execute(select(UserFile).where(UserFile.id.in_(file_ids), UserFile.trashed_at.is_(None)))).scalars()
    } if file_ids else {}
    folders = {
        f.id: f
        for f in (await db.execute(select(FileFolder).where(FileFolder.id.in_(folder_ids), FileFolder.trashed_at.is_(None)))).scalars()
    } if folder_ids else {}
    out: list[dict] = []
    for g in grants:
        direction = "mine" if g.granted_by_user_id == viewer.id else "theirs"
        if g.resource_type == "file" and g.resource_id in files:
            f = files[g.resource_id]
            out.append({"id": str(f.id), "type": "file", "name": f.filename, "mime": f.mime_type, "source_kind": f.source_kind, "direction": direction})
        elif g.resource_type == "folder" and g.resource_id in folders:
            f = folders[g.resource_id]
            out.append({"id": str(f.id), "type": "folder", "name": f.name, "mime": None, "source_kind": None, "direction": direction})
        if len(out) >= MAX_FILES:
            break
    return out


async def _page(db: AsyncSession, viewer: User, p: Person) -> dict[str, Any]:
    from app.items import service as items

    is_me = p.user is not None and p.user.id == viewer.id
    contact = None
    if p.contact is not None and p.file_id is not None:
        try:
            _row, _doc, access = await items.load(db, viewer, p.file_id)
        except items.ItemNotFound:
            access = "read"
        contact = _contact_out(p.file_id, p.contact, access == "edit")
        contact["name"] = p.contact_name
    out: dict[str, Any] = {
        "name": p.name,
        "is_me": is_me,
        "label": p.label,
        "match": p.match,
        "user": _user_out(p.user) if p.user else None,
        "face": _crop(p.cover, viewer),
        "contact": contact,
        "photo_person_id": str(p.person_id) if p.person_id else None,
        "photos": await _photos(db, viewer, p.person_id) if p.person_id else None,
        "events": [],
        "dm_room_id": None,
        "rooms": [],
        "files": [],
        # Only whether *you* blocked them — never whether they blocked you.
        "blocked": False,
    }
    if p.user is not None and not is_me:
        from .blocks import has_blocked

        out["blocked"] = await has_blocked(db, viewer.id, p.user.id)
        out["events"] = await _events(db, viewer, p.user)
        out["dm_room_id"], out["rooms"] = await _rooms(db, viewer, p.user)
        out["files"] = await _files(db, viewer, p.user)
    return out


# ------------------------------------------------------------------ routes


@router.get("/u/{user_id}")
async def person_by_user(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), viewer: User = Depends(get_current_user)) -> dict:
    return await _page(db, viewer, await _by_user(db, viewer, user_id))


# ------------------------------------------------------------------ blocking (app/people/blocks.py)


@router.get("/blocks")
async def list_blocks(db: AsyncSession = Depends(get_db), viewer: User = Depends(get_current_user)) -> list[dict]:
    """The people you've blocked, newest first (Account → Blocked people)."""
    from .blocks import UserBlock

    rows = (
        await db.execute(
            select(UserBlock, User)
            .join(User, User.id == UserBlock.blocked_id)
            .where(UserBlock.blocker_id == viewer.id)
            .order_by(UserBlock.created_at.desc())
        )
    ).all()
    return [{**_user_out(u), "blocked_at": b.created_at.isoformat()} for b, u in rows]


@router.put("/blocks/{user_id}")
async def block_person(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), viewer: User = Depends(get_current_user)) -> dict:
    """Block someone. They aren't told. Idempotent."""
    from . import blocks

    if user_id == viewer.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You can't block yourself")
    target = await db.get(User, user_id)
    if target is None or target.disabled:
        raise _not_found()
    await blocks.block(db, viewer.id, user_id)
    await db.commit()
    await _blocks_changed(db, viewer.id, user_id)
    return {"user_id": str(user_id), "blocked": True}


@router.delete("/blocks/{user_id}")
async def unblock_person(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), viewer: User = Depends(get_current_user)) -> dict:
    """Unblock someone you blocked. 404 when you hadn't."""
    from . import blocks

    if not await blocks.unblock(db, viewer.id, user_id):
        raise _not_found()
    await db.commit()
    await _blocks_changed(db, viewer.id, user_id)
    return {"user_id": str(user_id), "blocked": False}


async def _blocks_changed(db: AsyncSession, me: uuid.UUID, other: uuid.UUID) -> None:
    """Refresh your 1:1 conversation with them in Rooms (live), so its
    composer opens or closes. Only you get the event — they aren't told."""
    try:
        from app.rooms import core as rooms_core
        from app.rooms.models import Room, RoomMember

        mine = select(RoomMember.room_id).where(RoomMember.user_id == me)
        theirs = select(RoomMember.room_id).where(RoomMember.user_id == other)
        room = (
            await db.execute(select(Room).where(Room.space_id.is_(None), Room.kind == "dm", Room.id.in_(mine), Room.id.in_(theirs)).limit(1))
        ).scalar_one_or_none()
        viewer = await db.get(User, me)
        if room is not None and viewer is not None:
            await rooms_core.publish([me], {"type": "room", "room": await rooms_core.room_out(db, room, viewer)})
    except Exception:  # noqa: BLE001 — live refresh is a nicety
        import logging

        logging.getLogger("promptly.people").warning("block live refresh failed", exc_info=True)


@router.get("/c/{file_id}/{contact_id}")
async def person_by_contact(
    file_id: uuid.UUID, contact_id: str, db: AsyncSession = Depends(get_db), viewer: User = Depends(get_current_user)
) -> dict:
    return await _page(db, viewer, await _by_contact(db, viewer, file_id, contact_id[:40]))


@router.get("/p/{person_id}")
async def person_by_photos(person_id: uuid.UUID, db: AsyncSession = Depends(get_db), viewer: User = Depends(get_current_user)) -> dict:
    return await _page(db, viewer, await _by_photo_person(db, viewer, person_id))


def _first(xs: list[dict] | None) -> str:
    return next(((x.get("value") or "").strip() for x in xs or [] if (x.get("value") or "").strip()), "")


def _address_line(c: dict) -> str:
    for a in c.get("addresses") or []:
        line = ", ".join(x for x in (a.get(k, "").strip() for k in ("street", "city", "region", "postcode", "country")) if x)
        if line:
            return line
    return ""


def _contact_ref(p: Person, details: bool) -> dict | None:
    if p.contact is None:
        return None
    out: dict[str, Any] = {"file_id": str(p.file_id), "contact_id": p.contact["id"]}
    if details:
        # The viewer's own contact card (``directory`` reads only their files)
        # — for item apps that fill in a phone / email / address from it.
        c = p.contact
        out.update(phone=_first(c.get("phones")), email=_first(c.get("emails")), address=_address_line(c),
                   company=(c.get("company") or "").strip())
    return out


def _row(p: Person, viewer: User, details: bool = False) -> dict:
    return {
        "key": str(p.user.id) if p.user else (f"c:{p.file_id}:{p.contact['id']}" if p.contact else f"p:{p.person_id}"),
        "user": _user_out(p.user) if p.user else None,
        "name": p.name,
        "label": p.label,
        "face": _crop(p.cover, viewer),
        "contact": _contact_ref(p, details),
        "photo_person_id": str(p.person_id) if p.person_id else None,
    }


def _hits(p: Person, needle: str) -> bool:
    words = [p.contact_name, p.person_name, p.label, p.user.username if p.user else None]
    if p.contact:
        words += [p.contact.get("nickname"), p.contact.get("first"), p.contact.get("last")]
    return any(needle in w.lower() for w in words if w)


async def _known_ids(db: AsyncSession, viewer: User) -> set[uuid.UUID]:
    """People you already share a space, conversation or workspace with, or
    have shared a file with — the picker's suggestions besides your contacts."""
    from app.chat.models import Workspace, WorkspaceShare
    from app.files.models import ResourceGrant
    from app.rooms.models import Room, RoomMember, RoomSpaceMember

    spaces = select(RoomSpaceMember.space_id).where(RoomSpaceMember.user_id == viewer.id)
    dms = select(RoomMember.room_id).join(Room, Room.id == RoomMember.room_id).where(Room.space_id.is_(None), RoomMember.user_id == viewer.id)
    my_ws = union(
        select(Workspace.id).where(Workspace.user_id == viewer.id),
        select(WorkspaceShare.workspace_id).where(WorkspaceShare.invitee_user_id == viewer.id, WorkspaceShare.status == "accepted"),
    )
    q = union(
        select(RoomSpaceMember.user_id).where(RoomSpaceMember.space_id.in_(spaces)),
        select(RoomMember.user_id).where(RoomMember.room_id.in_(dms)),
        select(Workspace.user_id).where(Workspace.id.in_(my_ws)),
        select(WorkspaceShare.invitee_user_id).where(WorkspaceShare.workspace_id.in_(my_ws), WorkspaceShare.status == "accepted"),
        select(ResourceGrant.grantee_user_id).where(ResourceGrant.granted_by_user_id == viewer.id),
    )
    return {i for i in (await db.execute(q)).scalars().all() if i is not None} - {viewer.id}


@router.get("/search")
async def search(
    q: str = Query(default="", max_length=80),
    details: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    viewer: User = Depends(get_current_user),
) -> dict:
    """The people picker. Blank: suggestions — your contacts on Promptly
    (labelled ones first), then people you already work with. Typed: your
    contacts and Photos people by name or label, and (2+ letters) anyone on
    this Promptly by username or email. Emails never come back; contacts and
    faces without an account come last, marked not on Promptly
    (``user`` null). ``details``: each row's ``contact`` also carries the
    first phone, email and address on the viewer's own contact card (never
    an account's email) — the item apps' person fields fill in from it."""
    term = q.strip().lower()
    people = await directory(db, viewer)
    seen: set[uuid.UUID] = set()
    on: list[dict] = []
    off: list[dict] = []

    def take(p: Person) -> None:
        if p.user is not None:
            if p.user.id in seen or p.user.id == viewer.id:
                return
            seen.add(p.user.id)
            on.append(_row(p, viewer, details))
        elif term:
            off.append(_row(p, viewer, details))

    mine = [p for p in people if (not term or _hits(p, term))]
    mine.sort(key=lambda p: (p.user is None, p.label is None, p.name.lower()))
    for p in mine:
        take(p)
    if not term:
        ids = await _known_ids(db, viewer) - seen
        if ids:
            rows = (await db.execute(select(User).where(User.id.in_(ids), User.disabled.is_(False)).order_by(User.username).limit(MAX_RESULTS))).scalars()
            for u in rows:
                take(Person(user=u))
    elif len(term) >= 2:
        esc = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = (
            await db.execute(
                select(User)
                .where(
                    User.disabled.is_(False),
                    User.id != viewer.id,
                    or_(User.username.ilike(f"%{esc}%", escape="\\"), User.email.ilike(f"%{esc}%", escape="\\")),
                )
                .order_by(User.username)
                .limit(MAX_RESULTS)
            )
        ).scalars()
        for u in rows:
            take(Person(user=u))
    return {"people": (on + off)[:MAX_RESULTS]}

"""Tags — the shared set, putting tags on things, and "everything tagged X".

Every read is the caller's own tags only, and "everything tagged X" keeps
only what the caller can still open right now: files and app files by
Drive's one read rule (:func:`app.files.access.readable_predicate` — so a
file that was unshared or trashed drops out), calendar events they're on
(not free/busy-only), albums they own or were added to.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.tags import items_sync as S
from app.tags.models import Tag, TagAssignment

NATIVE = {"file": "File", "event": "Event", "album": "Album"}
KINDS = set(NATIVE) | set(S.BY_ENTITY)
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class TagError(Exception):
    """Refused, with a message for the person (→ 400)."""


class TagConflict(Exception):
    """Another of this person's tags already has that name (→ 409)."""

    def __init__(self, other: Tag) -> None:
        super().__init__("exists")
        self.other = other


class NotFound(Exception):
    """→ 404 (also "not yours": existence isn't probeable)."""


# ------------------------------------------------------------------ helpers


def clean_name(name: str) -> str:
    v = S.norm(name)
    if not v:
        raise TagError("A tag needs a name.")
    return v


def clean_color(color: str | None) -> str | None:
    if color in (None, ""):
        return None
    if not _HEX.match(color):
        raise TagError("Colours are #rrggbb.")
    return color.lower()


def tag_out(t: Tag, count: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(t.id), "name": t.name, "color": t.color}
    if count is not None:
        out["count"] = count
    return out


async def get_tag(db: AsyncSession, user: User, tag_id: uuid.UUID) -> Tag:
    t = await db.get(Tag, tag_id)
    if t is None or t.user_id != user.id:
        raise NotFound()
    return t


async def _by_name(db: AsyncSession, user: User, name: str) -> Tag | None:
    return (
        await db.execute(select(Tag).where(Tag.user_id == user.id, func.lower(Tag.name) == name.lower()))
    ).scalar_one_or_none()


# --------------------------------------------------------------------- set


async def list_tags(db: AsyncSession, user: User, q: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    counts = (
        select(TagAssignment.tag_id, func.count().label("n"))
        .where(TagAssignment.user_id == user.id)
        .group_by(TagAssignment.tag_id)
        .subquery()
    )
    stmt = (
        select(Tag, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.tag_id == Tag.id)
        .where(Tag.user_id == user.id)
    )
    if q and q.strip():
        term = S.norm(q).lower()
        stmt = stmt.where(func.lower(Tag.name).contains(term, autoescape=True))
        stmt = stmt.order_by(func.lower(Tag.name).startswith(term, autoescape=True).desc(), func.lower(Tag.name))
    else:
        stmt = stmt.order_by(func.lower(Tag.name))
    return [tag_out(t, n) for t, n in (await db.execute(stmt.limit(limit))).all()]


async def create_tag(db: AsyncSession, user: User, name: str, color: str | None = None) -> Tag:
    name = clean_name(name)
    existing = await _by_name(db, user, name)
    if existing is not None:
        raise TagConflict(existing)
    t = Tag(user_id=user.id, name=name, color=clean_color(color))
    db.add(t)
    await db.flush()
    return t


async def update_tag(
    db: AsyncSession, user: User, tag: Tag, *, name: str | None = None, color: str | None = None, set_color: bool = False
) -> Tag:
    if set_color:
        tag.color = clean_color(color)
    if name is not None:
        new = clean_name(name)
        if new != tag.name:
            other = await _by_name(db, user, new)
            if other is not None and other.id != tag.id:
                raise TagConflict(other)
            old = tag.name
            tag.name = new
            await db.flush()
            # The apps keep their own spelling — rename it there too.
            await S.rewrite_names(db, user, [old], new)
    await db.flush()
    return tag


async def delete_tag(db: AsyncSession, user: User, tag: Tag) -> None:
    await S.rewrite_names(db, user, [tag.name], None)
    await db.execute(delete(TagAssignment).where(TagAssignment.tag_id == tag.id))
    await db.delete(tag)
    await db.flush()


async def merge_tags(db: AsyncSession, user: User, source: Tag, target: Tag) -> Tag:
    """Everything tagged ``source`` is tagged ``target``; ``source`` goes."""
    if source.id == target.id:
        raise TagError("Pick a different tag to merge into.")
    await S.rewrite_names(db, user, [source.name], target.name)
    # Native tags move over unless the thing already has the target.
    have = {
        (k, e)
        for k, e in (
            await db.execute(
                select(TagAssignment.entity_kind, TagAssignment.entity_id).where(TagAssignment.tag_id == target.id)
            )
        ).all()
    }
    rows = (await db.execute(select(TagAssignment).where(TagAssignment.tag_id == source.id))).scalars().all()
    for a in rows:
        if (a.entity_kind, a.entity_id) in have:
            await db.delete(a)
        else:
            a.tag_id = target.id
            have.add((a.entity_kind, a.entity_id))
    await db.flush()
    await db.delete(source)
    await db.flush()
    return target


# ------------------------------------------------------------ on a thing


async def _event_visible(db: AsyncSession, user: User, event_id: uuid.UUID) -> bool:
    from app.calendars.core import busy_only, shared_with_me
    from app.calendars.models import CalAttendee, CalEvent, CalMember

    ev = await db.get(CalEvent, event_id)
    if ev is None:
        return False
    m = await db.get(CalMember, (ev.calendar_id, user.id))
    att = await db.get(CalAttendee, (ev.id, user.id))
    if att is not None and att.hidden and m is None:
        att = None
    if m is not None and not busy_only(m, att):
        return True
    if att is not None:
        return True
    return await shared_with_me(db, ev.id, user)


async def _album_visible(db: AsyncSession, user: User, album_id: uuid.UUID) -> bool:
    from app.photos.album_models import Album, AlbumMember

    al = await db.get(Album, album_id)
    if al is None:
        return False
    return al.owner_id == user.id or await db.get(AlbumMember, (al.id, user.id)) is not None


async def can_see(db: AsyncSession, user: User, kind: str, entity_id: str) -> bool:
    from app.files.access import can_read

    try:
        if kind == "file":
            return await can_read(db, uuid.UUID(entity_id), user.id)
        if kind == "event":
            return await _event_visible(db, user, uuid.UUID(entity_id))
        if kind == "album":
            return await _album_visible(db, user, uuid.UUID(entity_id))
        src = S.BY_ENTITY.get(kind)
        if src is None:
            return False
        fid, sub = S.split_entity_id(entity_id)
    except ValueError:
        return False
    if not await can_read(db, fid, user.id):
        return False
    from app.items.models import ItemDocument

    doc = await db.get(ItemDocument, fid)
    return doc is not None and doc.kind == src.item_kind and any(str(t["id"]) == sub for t in src.things(doc.data or {}))


def _check_kind(kind: str) -> None:
    if kind not in KINDS:
        raise TagError(f"Things of kind {kind!r} can't be tagged.")


async def entity_tags(db: AsyncSession, user: User, kind: str, entity_id: str) -> list[dict[str, Any]]:
    """The caller's tags on one thing (nothing when they can't see it)."""
    _check_kind(kind)
    if not await can_see(db, user, kind, entity_id):
        raise NotFound()
    rows = (
        await db.execute(
            select(Tag)
            .join(TagAssignment, TagAssignment.tag_id == Tag.id)
            .where(Tag.user_id == user.id, TagAssignment.entity_kind == kind, TagAssignment.entity_id == entity_id)
            .order_by(func.lower(Tag.name))
        )
    ).scalars().all()
    return [tag_out(t) for t in rows]


def _file_id_for(kind: str, entity_id: str) -> uuid.UUID | None:
    if kind == "file":
        return uuid.UUID(entity_id)
    if kind in S.BY_ENTITY:
        return S.split_entity_id(entity_id)[0]
    return None


async def _app_edit(db: AsyncSession, user: User, kind: str, entity_id: str, change) -> None:  # noqa: ANN001
    from app.items.service import ItemError

    try:
        await S.edit_thing_tags(db, user, kind, entity_id, change)
    except LookupError as e:
        raise NotFound() from e
    except ItemError as e:
        raise TagError(str(e)) from e


async def set_entity_tags(db: AsyncSession, user: User, kind: str, entity_id: str, names: list[str]) -> list[dict[str, Any]]:
    """Make the caller's tags on one thing exactly ``names`` (creating new
    tags as needed)."""
    _check_kind(kind)
    if len(names) > 50:
        raise TagError("That's too many tags for one thing.")
    if kind in S.BY_ENTITY:
        await _app_edit(db, user, kind, entity_id, lambda _old: list(names))
        return await entity_tags(db, user, kind, entity_id)
    if not await can_see(db, user, kind, entity_id):
        raise NotFound()
    ids = set((await S.tag_ids_for(db, user.id, names)).values())
    rows = (
        await db.execute(
            select(TagAssignment).where(
                TagAssignment.user_id == user.id, TagAssignment.entity_kind == kind, TagAssignment.entity_id == entity_id
            )
        )
    ).scalars().all()
    have = set()
    for a in rows:
        if a.tag_id in ids:
            have.add(a.tag_id)
        else:
            await db.delete(a)
    for tid in ids - have:
        db.add(TagAssignment(tag_id=tid, user_id=user.id, entity_kind=kind, entity_id=entity_id, file_id=_file_id_for(kind, entity_id)))
    await db.flush()
    return await entity_tags(db, user, kind, entity_id)


async def assign(db: AsyncSession, user: User, tag: Tag, kind: str, entity_id: str) -> None:
    _check_kind(kind)
    if kind in S.BY_ENTITY:
        name = tag.name
        await _app_edit(db, user, kind, entity_id, lambda old: [*old, name])
        return
    if not await can_see(db, user, kind, entity_id):
        raise NotFound()
    exists = await db.scalar(
        select(TagAssignment.id).where(
            TagAssignment.tag_id == tag.id, TagAssignment.entity_kind == kind, TagAssignment.entity_id == entity_id
        )
    )
    if exists is None:
        db.add(TagAssignment(tag_id=tag.id, user_id=user.id, entity_kind=kind, entity_id=entity_id, file_id=_file_id_for(kind, entity_id)))
        await db.flush()


async def unassign(db: AsyncSession, user: User, tag: Tag, kind: str, entity_id: str) -> None:
    _check_kind(kind)
    if kind in S.BY_ENTITY:
        k = S.key(tag.name)
        await _app_edit(db, user, kind, entity_id, lambda old: [t for t in old if S.key(t) != k])
        return
    # Removing your own tag needs no access check: it's your label.
    await db.execute(
        delete(TagAssignment).where(
            TagAssignment.tag_id == tag.id, TagAssignment.entity_kind == kind, TagAssignment.entity_id == entity_id
        )
    )
    await db.flush()


# ------------------------------------------------------ everything tagged


async def tagged(db: AsyncSession, user: User, tag: Tag, limit: int = 1000) -> list[dict[str, Any]]:
    """Everything carrying ``tag`` that the caller can open right now."""
    rows = (
        await db.execute(
            select(TagAssignment.entity_kind, TagAssignment.entity_id, TagAssignment.file_id)
            .where(TagAssignment.tag_id == tag.id)
            .order_by(TagAssignment.created_at.desc())
            .limit(limit)
        )
    ).all()
    by_kind: dict[str, list[tuple[str, uuid.UUID | None]]] = {}
    for k, e, f in rows:
        by_kind.setdefault(k, []).append((e, f))
    out: list[dict[str, Any]] = []
    out += await _files_out(db, user, by_kind)
    out += await _events_out(db, user, [e for e, _ in by_kind.get("event", [])])
    out += await _albums_out(db, user, [e for e, _ in by_kind.get("album", [])])
    return out


async def readable_file_ids(db: AsyncSession, user: User, ids: set[uuid.UUID]) -> set[uuid.UUID]:
    if not ids:
        return set()
    from app.files.access import readable_predicate

    res = await db.execute(
        text(f"SELECT f.id FROM files AS f WHERE f.id = ANY(CAST(:ids AS uuid[])) AND {readable_predicate('f')}"),
        {"ids": [str(i) for i in ids], "reader_id": str(user.id)},
    )
    return {r[0] if isinstance(r[0], uuid.UUID) else uuid.UUID(str(r[0])) for r in res.all()}


async def _files_out(db: AsyncSession, user: User, by_kind: dict[str, list[tuple[str, uuid.UUID | None]]]) -> list[dict[str, Any]]:
    from app.files.models import UserFile
    from app.items.models import ItemDocument

    wanted: set[uuid.UUID] = set()
    for k, pairs in by_kind.items():
        if k == "file" or k in S.BY_ENTITY:
            wanted |= {f for _, f in pairs if f is not None}
    ok = await readable_file_ids(db, user, wanted)
    if not ok:
        return []
    files = {f.id: f for f in (await db.execute(select(UserFile).where(UserFile.id.in_(ok)))).scalars()}
    docs = {d.file_id: d for d in (await db.execute(select(ItemDocument).where(ItemDocument.file_id.in_(ok)))).scalars()}
    out: list[dict[str, Any]] = []
    for e, f in by_kind.get("file", []):
        row = files.get(f) if f else None
        if row is None:
            continue
        out.append({"kind": "file", "id": e, "app": "Files", "title": row.filename, "detail": "",
                    "url": f"/files/f/{row.id}", "file_id": str(row.id)})
    for k, pairs in by_kind.items():
        src = S.BY_ENTITY.get(k)
        if src is None:
            continue
        for e, f in pairs:
            doc = docs.get(f) if f else None
            if doc is None or doc.kind != src.item_kind:
                continue
            try:
                _fid, sub = S.split_entity_id(e)
            except ValueError:
                continue
            thing = next((t for t in src.things(doc.data or {}) if str(t["id"]) == sub), None)
            if thing is None:
                continue
            out.append({"kind": k, "id": e, "app": src.label, "title": src.title(thing), "detail": "",
                        "url": src.url(doc.file_id, thing), "file_id": str(doc.file_id)})
    return out


async def visible_event_ids(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.calendars.models import CalAttendee, CalEvent, CalMember

    if not ids:
        return set()
    member = select(CalMember.calendar_id).where(CalMember.user_id == user.id, CalMember.role != "busy")
    invited = select(CalAttendee.event_id).where(CalAttendee.user_id == user.id, CalAttendee.hidden.is_(False))
    seen = set(
        (
            await db.execute(
                select(CalEvent.id).where(CalEvent.id.in_(ids), or_(CalEvent.calendar_id.in_(member), CalEvent.id.in_(invited)))
            )
        ).scalars()
    )
    for eid in set(ids) - seen:
        if await _event_visible(db, user, eid):
            seen.add(eid)
    return seen


async def _events_out(db: AsyncSession, user: User, raw: list[str]) -> list[dict[str, Any]]:
    from app.calendars.models import CalEvent

    ids = []
    for e in raw:
        try:
            ids.append(uuid.UUID(e))
        except ValueError:
            continue
    ok = await visible_event_ids(db, user, ids)
    if not ok:
        return []
    evs = (await db.execute(select(CalEvent).where(CalEvent.id.in_(ok)).order_by(CalEvent.start_at.desc()))).scalars()
    return [
        {"kind": "event", "id": str(ev.id), "app": "Calendar", "title": ev.title,
         "detail": (ev.start_at.date().isoformat() if ev.all_day else ev.start_at.isoformat()),
         "url": f"/calendar?event={ev.id}"}
        for ev in evs
    ]


async def _albums_out(db: AsyncSession, user: User, raw: list[str]) -> list[dict[str, Any]]:
    from app.photos.album_models import Album, AlbumMember

    ids = []
    for e in raw:
        try:
            ids.append(uuid.UUID(e))
        except ValueError:
            continue
    if not ids:
        return []
    member = select(AlbumMember.album_id).where(AlbumMember.user_id == user.id)
    rows = (
        await db.execute(
            select(Album).where(Album.id.in_(ids), or_(Album.owner_id == user.id, Album.id.in_(member))).order_by(Album.title)
        )
    ).scalars()
    return [{"kind": "album", "id": str(a.id), "app": "Photos", "title": a.title, "detail": "Album",
             "url": f"/photos/albums/{a.id}"} for a in rows]


# ------------------------------------------------------------------ search


async def search(db: AsyncSession, user: User, term: str, limit: int = 5) -> list[dict[str, Any]]:
    """Tags matching ``term`` ("#home" or "home"), for the search box."""
    term = S.norm(term)
    if not term:
        return []
    out = await list_tags(db, user, term, limit=limit)
    for t in out:
        t["url"] = f"/tags/{t['id']}"
    return out


__all__ = [
    "KINDS", "NATIVE", "NotFound", "TagConflict", "TagError", "assign", "can_see", "create_tag", "delete_tag",
    "entity_tags", "get_tag", "list_tags", "merge_tags", "search", "set_entity_tags", "tag_out", "tagged",
    "unassign", "update_tag",
]

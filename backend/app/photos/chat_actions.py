"""Doing things with photos from a chat (PH-4 follow-up): "make an album of
these", "add them to Holiday", "share it with Sam", "Sarah is my wife".

The chat's tools never act: each files a proposal (a preview card) through
:func:`check_*`, and the person applies it — :func:`apply_*` checks it all
again at that moment (the album may be gone, they may no longer own it).

Proposal kinds and payloads:

* ``photo_album`` — ``{action: "create"|"add", title, album_id?, file_ids,
  count, smart_rules?}``: a new album (or a smart one that keeps itself up
  to date) or more photos in an album they own or contribute to;
* ``photo_share`` — ``{album_id, album_title, role, people: [{user_id,
  username}]}``: albums they own, with people on this server, found by
  their exact username or email (never guessed);
* ``photo_relationship`` — ``{person_id, person_name, label, kind}``:
  who someone is to them, for "me and my wife" searches.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

ALBUM_MAX = 500


class ActionError(ValueError):
    """Something the model (or the person) should be told, plainly."""


async def _album_for(db: AsyncSession, user: Any, ref: str, *, need_owner: bool) -> Any:
    """An album by id or (case-insensitive) title that this person owns —
    or, unless ``need_owner``, contributes to."""
    from app.photos.album_models import Album, AlbumMember

    ref = (ref or "").strip()
    if not ref:
        raise ActionError("Which album?")
    q = select(Album).outerjoin(AlbumMember, (AlbumMember.album_id == Album.id) & (AlbumMember.user_id == user.id))
    allowed = Album.owner_id == user.id if need_owner else or_(Album.owner_id == user.id, AlbumMember.role == "contributor")
    try:
        found = (await db.execute(q.where(allowed, Album.id == uuid.UUID(ref)))).scalars().first()
    except ValueError:
        rows = (await db.execute(q.where(allowed, func.lower(Album.title) == ref.lower()))).scalars().all()
        if len(rows) > 1:
            raise ActionError(f"There's more than one album called “{ref}” — ask which.") from None
        found = rows[0] if rows else None
    if found is None:
        raise ActionError(
            f"No album “{ref}” that you {'own' if need_owner else 'can add to'}." + ("" if need_owner else " Offer to make a new one.")
        )
    return found


async def _photos_of(db: AsyncSession, user: Any, set_args: dict[str, Any] | None, file_ids: list[str] | None) -> list[str]:
    from app.photos import engine
    from app.photos.albums_router import _own_photos

    if set_args is not None:
        q = engine.query_from(set_args)
        q.limit = ALBUM_MAX
        got = await engine.search(db, user, q)
        ids = [it["id"] for it in got["items"]]
    else:
        ids = []
        for raw in file_ids or []:
            try:
                ids.append(str(uuid.UUID(str(raw))))
            except ValueError:
                continue
    own = await _own_photos(db, user, [uuid.UUID(i) for i in ids[:ALBUM_MAX]])
    return [str(i) for i in own]


async def check_album(
    db: AsyncSession, user: Any, *, set_args: dict[str, Any] | None, file_ids: list[str] | None,
    title: str | None, album: str | None, smart: bool,
) -> dict[str, Any]:
    if album:
        target = await _album_for(db, user, album, need_owner=False)
        ids = await _photos_of(db, user, set_args, file_ids)
        if not ids:
            raise ActionError("None of those are your photos, so there's nothing to add.")
        return {"action": "add", "album_id": str(target.id), "title": target.title, "file_ids": ids, "count": len(ids),
                "summary": f"Add {len(ids)} photo{'s' if len(ids) != 1 else ''} to “{target.title}”"}
    title = (title or "").strip()[:200]
    if not title:
        raise ActionError("Give the new album a name.")
    if smart:
        if set_args is None:
            raise ActionError("A smart album needs a search to follow — search first, then make it from the result set.")
        from app.photos.albums_router import _rules

        try:
            rules = await _rules(db, user, set_args, None)
        except Exception as exc:  # an HTTPException from the checks
            raise ActionError(getattr(exc, "detail", None) or "That search can't be an album.") from exc
        from app.photos import engine

        ids = await engine.matching(db, user, engine.query_from(rules)) or []
        return {"action": "create", "title": title, "smart_rules": rules, "file_ids": [str(i) for i in ids[:12]],
                "count": len(ids), "summary": f"New smart album “{title}” — {len(ids)} photos now, and new ones as they come"}
    ids = await _photos_of(db, user, set_args, file_ids)
    if not ids:
        raise ActionError("None of those are your photos, so there's nothing to put in an album.")
    return {"action": "create", "title": title, "file_ids": ids, "count": len(ids),
            "summary": f"New album “{title}” with {len(ids)} photo{'s' if len(ids) != 1 else ''}"}


async def apply_album(db: AsyncSession, user: Any, payload: dict[str, Any]) -> uuid.UUID:
    from app.photos.album_models import Album
    from app.photos.albums_router import _add_items

    ids = [uuid.UUID(i) for i in payload.get("file_ids") or []]
    if payload.get("action") == "add":
        album = await _album_for(db, user, payload["album_id"], need_owner=False)
        await _add_items(db, album, user, ids)
        return album.id
    rules = payload.get("smart_rules")
    album = Album(owner_id=user.id, title=payload["title"], rules=rules)
    db.add(album)
    await db.flush()
    if rules:
        from app.photos import smart

        await smart.refresh(db, album.id)
    else:
        await _add_items(db, album, user, ids)
    return album.id


async def _person_by_name(db: AsyncSession, who: str) -> Any:
    from app.auth.models import User

    w = (who or "").strip().lstrip("@").lower()
    if not w:
        return None
    return (await db.execute(
        select(User).where(or_(func.lower(User.username) == w, func.lower(User.email) == w), User.disabled.is_(False))
    )).scalars().first()


async def check_share(db: AsyncSession, user: Any, *, album: str, people: list[str], role: str) -> dict[str, Any]:
    target = await _album_for(db, user, album, need_owner=True)
    found, missing = [], []
    for who in people[:20]:
        other = await _person_by_name(db, who)
        if other is None or other.id == user.id:
            missing.append(who)
        elif all(p["user_id"] != str(other.id) for p in found):
            found.append({"user_id": str(other.id), "username": other.username})
    if missing:
        raise ActionError(
            "Couldn't find " + ", ".join(f"“{m}”" for m in missing) + " on this server — sharing needs their exact username or email."
        )
    if not found:
        raise ActionError("Share it with whom?")
    role = "contributor" if role == "contributor" else "viewer"
    names = ", ".join(p["username"] for p in found)
    return {"album_id": str(target.id), "album_title": target.title, "role": role, "people": found,
            "summary": f"Share “{target.title}” with {names} ({'can add photos' if role == 'contributor' else 'can see it'})"}


async def apply_share(db: AsyncSession, user: Any, payload: dict[str, Any]) -> uuid.UUID:
    from app.photos.album_models import AlbumMember
    from app.photos.albums_router import MemberRequest, add_member

    album = await _album_for(db, user, payload["album_id"], need_owner=True)
    for p in payload.get("people") or []:
        member = await db.get(AlbumMember, (album.id, uuid.UUID(p["user_id"])))
        if member is not None and member.role == payload["role"]:
            continue
        await add_member(album.id, MemberRequest(user_id=uuid.UUID(p["user_id"]), role=payload["role"]), db=db, user=user)
    return album.id


async def check_relationship(db: AsyncSession, user: Any, *, person: str, label: str) -> dict[str, Any]:
    from app.photos.people import relation_kind

    label = (label or "").strip()[:60]
    if not label:
        raise ActionError("Who are they to the user?")
    rows = (await db.execute(
        text("SELECT id, name FROM photo_people WHERE user_id = :u AND kind = 'person' AND lower(name) = lower(:n)"),
        {"u": user.id, "n": (person or "").strip()},
    )).all()
    if not rows:
        raise ActionError(f"No one called “{person}” is named in their photos yet — they can name them in Photos → People.")
    if len(rows) > 1:
        raise ActionError(f"More than one person is called “{person}” in their photos — they can set it on the right one in People.")
    pid, name = rows[0]
    return {"person_id": str(pid), "person_name": name, "label": label, "kind": relation_kind(label),
            "summary": f"Remember {name} as “{label}” in Photos"}


async def apply_relationship(db: AsyncSession, user: Any, payload: dict[str, Any]) -> uuid.UUID:
    from app.photos.people import set_relationship

    pid = uuid.UUID(payload["person_id"])
    owner = await db.scalar(text("SELECT user_id FROM photo_people WHERE id = :p"), {"p": pid})
    if owner != user.id:
        raise ActionError("That person isn't in your photos any more.")
    await set_relationship(db, user.id, pid, payload["label"], source="chat")
    return pid


__all__ = ["ActionError", "apply_album", "apply_relationship", "apply_share", "check_album", "check_relationship", "check_share"]

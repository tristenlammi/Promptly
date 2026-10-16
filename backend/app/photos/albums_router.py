"""Albums (WP-9.4, Part E PH-1).

    GET    /api/photos/albums                      yours and ones shared with you
    POST   /api/photos/albums                      a new album (optionally with photos)
    GET    /api/photos/albums/{id}                 the album, its members, your role
    PATCH  /api/photos/albums/{id}                 title / description / cover / sort (owner)
    DELETE /api/photos/albums/{id}                 delete it (owner) — the photos stay
    GET    /api/photos/albums/{id}/items           its photos, a page at a time
    POST   /api/photos/albums/{id}/items           add your photos (owner, contributors)
    DELETE /api/photos/albums/{id}/items           take photos out
    POST   /api/photos/albums/{id}/members         add someone (owner)
    PATCH  /api/photos/albums/{id}/members/{uid}   change their role (owner)
    DELETE /api/photos/albums/{id}/members/{uid}   remove them, or leave
    POST   /api/photos/albums/preview              what a smart album's question would hold (PH-5)

A **smart album** (PH-5) has ``rules`` — a saved question, kept up to date by
:mod:`app.photos.smart`; photos taken out of it stay out.

An album holds references, never copies. You only add photos you own —
otherwise adding something shared with you would pass it on to everyone in
the album. Members see every photo in it (with location: they're people you
chose to share with, decision D13). Someone who leaves takes their photos
out with them.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileMedia, UserFile
from app.photos.album_models import Album, AlbumExclusion, AlbumItem, AlbumMember
from app.photos.models import PhotoAsset

router = APIRouter()

Role = Literal["owner", "contributor", "viewer"]


class AlbumCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    file_ids: list[uuid.UUID] = Field(default_factory=list, max_length=2000)
    # A smart album: the question as fields (the chat tool's shape), or in words.
    rules: dict[str, Any] | None = None
    q: str | None = Field(default=None, max_length=300)


class RulesPreview(BaseModel):
    rules: dict[str, Any] | None = None
    q: str | None = Field(default=None, max_length=300)


class AlbumPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    cover_file_id: uuid.UUID | None = None
    sort: Literal["newest", "oldest"] | None = None
    # Change the question; null makes it an ordinary album (its photos stay).
    rules: dict[str, Any] | None = None


class ItemsRequest(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)


class MemberRequest(BaseModel):
    user_id: uuid.UUID
    role: Literal["viewer", "contributor"] = "viewer"


class RoleRequest(BaseModel):
    role: Literal["viewer", "contributor"]


async def _album(db: AsyncSession, album_id: uuid.UUID, user: User) -> tuple[Album, Role]:
    """The album and the caller's role in it — 404 when they have none."""
    album = await db.get(Album, album_id)
    if album is not None and album.owner_id == user.id:
        return album, "owner"
    if album is not None:
        member = await db.get(AlbumMember, (album.id, user.id))
        if member is not None:
            return album, member.role  # type: ignore[return-value]
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such album.")


def _need(role: Role, *allowed: Role) -> None:
    if role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the album's owner can do that." if allowed == ("owner",) else "You can only look at this album.",
        )


def _visible_items():  # noqa: ANN202 — a WHERE clause over AlbumItem ⨝ UserFile
    return UserFile.trashed_at.is_(None)


async def _counts(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(AlbumItem.album_id, func.count())
            .join(UserFile, UserFile.id == AlbumItem.file_id)
            .where(AlbumItem.album_id.in_(ids), _visible_items())
            .group_by(AlbumItem.album_id)
        )
    ).all()
    return dict(rows)


async def _cover(db: AsyncSession, album: Album, user: User) -> dict[str, Any] | None:
    """The cover (chosen, else the newest photo) as a tile."""
    from app.photos.router import _item

    q = (
        select(PhotoAsset, UserFile, FileMedia)
        .select_from(AlbumItem)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == AlbumItem.file_id)
        .where(AlbumItem.album_id == album.id, _visible_items())
    )
    if album.cover_file_id:
        row = (await db.execute(q.where(AlbumItem.file_id == album.cover_file_id))).first()
        if row:
            return _item(*row, user)
    row = (await db.execute(q.order_by(PhotoAsset.taken_local.desc()).limit(1))).first()
    return _item(*row, user) if row else None


async def _rules(db: AsyncSession, user: User, rules: dict[str, Any] | None, q: str | None) -> dict[str, Any]:
    """A smart album's question, checked: everyone in it found (else 422),
    and a person or pet chosen by name kept by id (a rename doesn't break
    it; "me" and "my kids" stay as said, so they follow)."""
    from sqlalchemy import text as sql

    from app.photos import engine
    from app.photos.people import relation_kind

    if q and q.strip():
        names = (await db.execute(
            sql("SELECT name, kind FROM photo_people WHERE user_id = :u AND name IS NOT NULL"), {"u": user.id}
        )).all()
        query = engine.parse(q, people_names=[n for n, k in names if k == "person"], pet_names=[n for n, k in names if k == "pet"])
    else:
        query = engine.query_from(rules or {})
    r = await engine.resolve(db, user, query)
    if r.unresolved:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Couldn't find " + "; ".join(r.unresolved) + ".")
    people_groups = [g for g in r.groups if g.kind == "person"]
    pet_groups = [g for g in r.groups if g.kind == "pet"]

    def pin(refs: list[str], groups: list[Any], kind: str) -> list[str]:
        out = []
        for ref, g in zip(refs, groups):
            low = ref.strip().lower()
            dynamic = low.startswith("id:") or low in ("me", "myself", "i", "you") or (kind == "person" and relation_kind(ref) != "other")
            out.append(ref if dynamic or len(g.ids) != 1 else f"id:{g.ids[0]}")
        return out

    query.people = pin(query.people, people_groups, "person")
    query.pets = pin(query.pets, pet_groups, "pet")
    if not (query.people or query.pets or query.species or query.place or query.date_from or query.date_to
            or query.media or query.text or query.visual or query.favorites):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Say what the album should hold.")
    return engine.args_of(query)


async def _out(db: AsyncSession, album: Album, role: Role, user: User, count: int, owner: User | None) -> dict[str, Any]:
    rules = None
    if album.rules:
        from app.photos import engine, smart

        rules = {"rules": album.rules, "summary": engine.summary(engine.query_from(album.rules), await smart.rule_names(db, album.rules))}
    return {
        "smart": rules,
        "id": str(album.id),
        "title": album.title,
        "description": album.description,
        "sort": album.sort,
        "role": role,
        "owner": {"id": str(album.owner_id), "username": owner.username if owner else None},
        "count": count,
        "cover": await _cover(db, album, user),
        "created_at": album.created_at.isoformat(),
        "updated_at": album.updated_at.isoformat(),
    }


@router.get("")
async def list_albums(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    member_of = select(AlbumMember.album_id).where(AlbumMember.user_id == user.id)
    albums = (
        await db.execute(
            select(Album).where(or_(Album.owner_id == user.id, Album.id.in_(member_of))).order_by(Album.updated_at.desc())
        )
    ).scalars().all()
    roles = dict(
        (await db.execute(select(AlbumMember.album_id, AlbumMember.role).where(AlbumMember.user_id == user.id))).all()
    )
    counts = await _counts(db, [a.id for a in albums])
    shared = set((await db.execute(select(AlbumMember.album_id).where(AlbumMember.album_id.in_([a.id for a in albums])))).scalars())
    owners = {u.id: u for u in (await db.execute(select(User).where(User.id.in_({a.owner_id for a in albums})))).scalars()}
    out = []
    for a in albums:
        role: Role = "owner" if a.owner_id == user.id else roles.get(a.id, "viewer")
        item = await _out(db, a, role, user, counts.get(a.id, 0), owners.get(a.owner_id))
        item["shared"] = a.id in shared
        out.append(item)
    return {"albums": out}


async def _own_photos(db: AsyncSession, user: User, file_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """The ones that are the caller's own photos or videos (and not trashed)."""
    rows = (
        await db.execute(
            select(UserFile.id)
            .join(PhotoAsset, PhotoAsset.file_id == UserFile.id)
            .where(UserFile.id.in_(file_ids), UserFile.user_id == user.id, UserFile.trashed_at.is_(None))
        )
    ).scalars().all()
    return list(rows)


async def _add_items(db: AsyncSession, album: Album, user: User, file_ids: list[uuid.UUID]) -> int:
    ids = await _own_photos(db, user, file_ids)
    if not ids:
        return 0
    result = await db.execute(
        insert(AlbumItem)
        .values([{"album_id": album.id, "file_id": fid, "added_by": user.id} for fid in ids])
        .on_conflict_do_nothing(index_elements=["album_id", "file_id"])
    )
    album.updated_at = func.now()
    return result.rowcount or 0


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_album(
    payload: AlbumCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    rules = await _rules(db, user, payload.rules, payload.q) if (payload.rules or payload.q) else None
    album = Album(owner_id=user.id, title=payload.title.strip() or "Untitled album", rules=rules)
    db.add(album)
    await db.flush()
    added = await _add_items(db, album, user, payload.file_ids) if payload.file_ids else 0
    if rules:
        from app.photos import smart

        got = await smart.refresh(db, album.id)
        added += got[0] if got else 0
    await db.commit()
    await db.refresh(album)
    return await _out(db, album, "owner", user, added, user)


@router.post("/preview")
async def preview_rules(
    payload: RulesPreview, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """What a smart album with this question would hold now: how many,
    and the newest few — as the rule builder is filled in."""
    from app.files.models import FileMedia, UserFile
    from app.photos import engine, smart
    from app.photos.models import PhotoAsset
    from app.photos.router import _item

    rules = await _rules(db, user, payload.rules, payload.q)
    ids = await engine.matching(db, user, engine.query_from(rules))
    if ids is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Looking at what photos show needs the photos service.")
    sample = (
        await db.execute(
            select(PhotoAsset, UserFile, FileMedia).join(UserFile, UserFile.id == PhotoAsset.file_id)
            .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
            .where(PhotoAsset.file_id.in_(ids[:5000])).order_by(PhotoAsset.taken_local.desc()).limit(12)
        )
    ).all() if ids else []
    return {
        "count": len(ids), "rules": rules,
        "summary": engine.summary(engine.query_from(rules), await smart.rule_names(db, rules)),
        "sample": [_item(a, f, m, user) for a, f, m in sample],
    }


@router.get("/{album_id}")
async def get_album(
    album_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    album, role = await _album(db, album_id, user)
    owner = await db.get(User, album.owner_id)
    count = (await _counts(db, [album.id])).get(album.id, 0)
    out = await _out(db, album, role, user, count, owner)
    members = (
        await db.execute(
            select(AlbumMember, User).join(User, User.id == AlbumMember.user_id).where(AlbumMember.album_id == album.id)
            .order_by(AlbumMember.added_at)
        )
    ).all()
    out["members"] = [{"user_id": str(u.id), "username": u.username, "role": m.role} for m, u in members]
    return out


@router.patch("/{album_id}")
async def update_album(
    album_id: uuid.UUID, payload: AlbumPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    album, role = await _album(db, album_id, user)
    _need(role, "owner")
    if payload.title is not None:
        album.title = payload.title.strip()
    if payload.description is not None:
        album.description = payload.description.strip() or None
    if payload.sort is not None:
        album.sort = payload.sort
    if "rules" in payload.model_fields_set:
        from app.photos import smart

        album.rules = await _rules(db, user, payload.rules, None) if payload.rules else None
        if album.rules:
            await db.flush()
            await smart.refresh(db, album.id)
        else:
            # An ordinary album now: what the question put there stays, as photos.
            await db.execute(
                update(AlbumItem).where(AlbumItem.album_id == album.id, AlbumItem.via_rule.is_(True)).values(via_rule=False)
            )
    if payload.cover_file_id is not None:
        inside = await db.get(AlbumItem, (album.id, payload.cover_file_id))
        if inside is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The cover must be in the album.")
        album.cover_file_id = payload.cover_file_id
    await db.commit()
    await db.refresh(album)  # its updated_at comes back from the database
    return await get_album(album.id, db=db, user=user)


@router.delete("/{album_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_album(album_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    album, role = await _album(db, album_id, user)
    _need(role, "owner")
    # Its public links stop with it (WP-9.5).
    from sqlalchemy import update

    from app.files.models import FileShareLink

    await db.execute(
        update(FileShareLink)
        .where(FileShareLink.resource_type == "album", FileShareLink.resource_id == album.id, FileShareLink.revoked_at.is_(None))
        .values(revoked_at=func.now())
    )
    await db.delete(album)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{album_id}/items")
async def album_items(
    album_id: uuid.UUID,
    before: str | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.photos.router import _cursor, _item, _uncursor

    album, _role = await _album(db, album_id, user)
    newest = album.sort != "oldest"
    q = (
        select(PhotoAsset, UserFile, FileMedia, AlbumItem.added_by)
        .select_from(AlbumItem)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == AlbumItem.file_id)
        .where(AlbumItem.album_id == album.id, _visible_items())
    )
    if before:
        when, fid = _uncursor(before)
        if newest:
            q = q.where(or_(PhotoAsset.taken_local < when, and_(PhotoAsset.taken_local == when, PhotoAsset.file_id < fid)))
        else:
            q = q.where(or_(PhotoAsset.taken_local > when, and_(PhotoAsset.taken_local == when, PhotoAsset.file_id > fid)))
    order = (
        (PhotoAsset.taken_local.desc(), PhotoAsset.file_id.desc()) if newest else (PhotoAsset.taken_local.asc(), PhotoAsset.file_id.asc())
    )
    rows = (await db.execute(q.order_by(*order).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]
    items = []
    for asset, row, media, added_by in rows:
        item = _item(asset, row, media, user)
        item["added_by"] = str(added_by) if added_by else None
        item["mine"] = row.user_id == user.id
        items.append(item)
    nxt = _cursor(rows[-1][0].taken_local, rows[-1][0].file_id) if more and rows else None
    return {"items": items, "next_cursor": nxt}


@router.post("/{album_id}/items")
async def add_items(
    album_id: uuid.UUID, payload: ItemsRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, int]:
    album, role = await _album(db, album_id, user)
    _need(role, "owner", "contributor")
    added = await _add_items(db, album, user, payload.file_ids)
    await db.commit()
    return {"added": added}


@router.delete("/{album_id}/items")
async def remove_items(
    album_id: uuid.UUID, payload: ItemsRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, int]:
    album, role = await _album(db, album_id, user)
    _need(role, "owner", "contributor")
    cond = [AlbumItem.album_id == album.id, AlbumItem.file_id.in_(payload.file_ids)]
    if role != "owner":
        cond.append(AlbumItem.added_by == user.id)  # a contributor takes out only what they put in
    result = await db.execute(delete(AlbumItem).where(*cond))
    if album.rules:
        # Out of a smart album for good: its question won't put them back.
        await db.execute(
            insert(AlbumExclusion).values([{"album_id": album.id, "file_id": f} for f in payload.file_ids]).on_conflict_do_nothing()
        )
    if album.cover_file_id in payload.file_ids:
        album.cover_file_id = None
    await db.commit()
    return {"removed": result.rowcount or 0}


@router.post("/{album_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(
    album_id: uuid.UUID, payload: MemberRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    album, role = await _album(db, album_id, user)
    _need(role, "owner")
    other = await db.get(User, payload.user_id)
    if other is None or other.id == user.id or getattr(other, "disabled", False):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such person.")
    member = await db.get(AlbumMember, (album.id, other.id))
    fresh = member is None
    if member is None:
        member = AlbumMember(album_id=album.id, user_id=other.id, role=payload.role)
        db.add(member)
    else:
        member.role = payload.role
    await db.commit()
    if fresh:
        try:
            from app.notifications.dispatch import notify_user

            can = "add photos to and see" if payload.role == "contributor" else "see"
            await notify_user(
                user_id=other.id, category="invite", title=f"{user.username} shared an album with you",
                body=f"You can {can} “{album.title}”.", url=f"/files/photos/albums/{album.id}", actor_user_id=user.id,
            )
        except Exception:  # noqa: BLE001 — telling them must never undo the share
            pass
    return {"user_id": str(other.id), "username": other.username, "role": member.role}


@router.patch("/{album_id}/members/{member_id}")
async def change_role(
    album_id: uuid.UUID, member_id: uuid.UUID, payload: RoleRequest,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    album, role = await _album(db, album_id, user)
    _need(role, "owner")
    member = await db.get(AlbumMember, (album.id, member_id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="They're not in this album.")
    member.role = payload.role
    await db.commit()
    return {"user_id": str(member_id), "role": member.role}


@router.delete("/{album_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    album_id: uuid.UUID, member_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> Response:
    album, role = await _album(db, album_id, user)
    if role != "owner" and member_id != user.id:
        _need(role, "owner")
    member = await db.get(AlbumMember, (album.id, member_id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="They're not in this album.")
    await db.delete(member)
    # Their photos leave with them.
    await db.execute(delete(AlbumItem).where(AlbumItem.album_id == album.id, AlbumItem.added_by == member_id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]

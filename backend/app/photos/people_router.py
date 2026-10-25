"""People and pets (PH-3) — the owner's API.

    GET   /api/photos/people?kind=person|pet     who's in your photos, most photos first
    GET   /api/photos/people/review              "Who is this?" — the biggest unnamed people
    GET   /api/photos/people/{id}                one, with its photos (keyset pages)
    PATCH /api/photos/people/{id}                name, hide, cover, "this is me"
    POST  /api/photos/people/{id}/merge          {"into": id} — the same person twice
    GET   /api/photos/files/{file_id}/people     the faces and animals in a photo, and who
    POST  /api/photos/faces/{id}/person          {"person_id"} or {"name"} — "this is …"
    POST  /api/photos/faces/{id}/not             {"person_id"} — "not them"
    PUT   /api/photos/people/{id}/relationship   {"label"} — "my wife"; yours only
    GET   /api/photos/people/{id}/faces          their faces (or a pet's photos), for splitting
    POST  /api/photos/people/{id}/split          {"observation_ids", "into" | "name"}

Faces are the owner's: only they see who's who in their photos (Part E §E4.8).
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileMedia, UserFile
from app.photos import people
from app.photos.library import in_library
from app.photos.models import PhotoAsset

router = APIRouter()

Kind = Literal["person", "pet"]


def _crop(obs_id: uuid.UUID | None, user: User) -> str | None:
    """A signed link to a face's (or animal's) square crop."""
    if obs_id is None:
        return None
    from app.files import media_urls

    return media_urls.sign(obs_id, user.id, user.token_version, "face", 1)


def _obs_table(kind: str) -> tuple[str, str]:
    return ("photo_faces", "person_id") if kind == "person" else ("photo_animals", "pet_id")


async def _list(db: AsyncSession, user: User, kind: str, *, hidden: bool, unnamed_only: bool = False, limit: int = 500) -> list[dict[str, Any]]:
    table, col = _obs_table(kind)
    rows = (
        await db.execute(
            text(
                f"SELECT p.id, p.name, p.hidden, p.memories_hidden, p.linked_user_id, p.species, r.label AS relation, "
                f"COALESCE(p.cover_id, (SELECT o2.id FROM {table} o2 WHERE o2.{col} = p.id "
                f"  ORDER BY o2.size_px * o2.score DESC LIMIT 1)) AS cover, "
                f"count(DISTINCT o.file_id) AS n "
                f"FROM photo_people p JOIN {table} o ON o.{col} = p.id JOIN files fl ON fl.id = o.file_id "
                f"LEFT JOIN photo_relationships r ON r.person_id = p.id AND r.viewer_user_id = :u "
                f"WHERE p.user_id = :u AND p.kind = :k AND fl.trashed_at IS NULL AND (:hidden OR NOT p.hidden) "
                f"AND (NOT :unnamed OR p.name IS NULL) "
                f"GROUP BY p.id, r.label HAVING p.name IS NOT NULL OR count(DISTINCT o.file_id) >= :min "
                f"ORDER BY (p.name IS NULL), count(DISTINCT o.file_id) DESC, p.name LIMIT :lim"
            ),
            {"u": user.id, "k": kind, "hidden": hidden, "unnamed": unnamed_only, "min": people.MIN_FACES, "lim": limit},
        )
    ).all()
    return [
        {
            "id": str(r.id), "name": r.name, "hidden": r.hidden, "species": r.species, "photos": int(r.n),
            "me": r.linked_user_id == user.id, "linked_user_id": str(r.linked_user_id) if r.linked_user_id else None,
            "relationship": r.relation,
            "memories": not r.memories_hidden,
            "cover": _crop(r.cover, user),
        }
        for r in rows
    ]


@router.get("/people")
async def list_people(
    kind: Kind = "person", hidden: bool = False,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {"people": await _list(db, user, kind, hidden=hidden)}


@router.get("/people/review")
async def review(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """The biggest unnamed people and pets first, with a few faces of each
    — name them once and they're named everywhere."""
    out = []
    for kind in ("person", "pet"):
        for p in await _list(db, user, kind, hidden=False, unnamed_only=True, limit=12):
            table, col = _obs_table(kind)
            samples = (
                await db.execute(
                    text(f"SELECT id FROM {table} WHERE {col} = :p ORDER BY size_px * score DESC LIMIT 8"),
                    {"p": uuid.UUID(p["id"])},
                )
            ).scalars().all()
            out.append({**p, "kind": kind, "samples": [{"id": str(s), "crop": _crop(s, user)} for s in samples]})
    # Animals nobody's named (or that weren't clearly any named pet), by
    # species: "A dog in 214 photos — who is this?"
    for species, n in (
        await db.execute(
            text(
                "SELECT a.species, count(DISTINCT a.file_id) FROM photo_animals a JOIN files fl ON fl.id = a.file_id "
                "WHERE a.user_id = :u AND a.pet_id IS NULL AND fl.trashed_at IS NULL GROUP BY a.species ORDER BY 2 DESC"
            ),
            {"u": user.id},
        )
    ).all():
        samples = (
            await db.execute(
                text(
                    "SELECT a.id FROM photo_animals a JOIN files fl ON fl.id = a.file_id WHERE a.user_id = :u "
                    "AND a.species = :s AND a.pet_id IS NULL AND fl.trashed_at IS NULL ORDER BY a.size_px * a.score DESC LIMIT 12"
                ),
                {"u": user.id, "s": species},
            )
        ).scalars().all()
        out.append({
            "id": None, "kind": "pet", "species": species, "name": None, "photos": int(n), "hidden": False, "me": False,
            "cover": _crop(samples[0], user) if samples else None,
            "samples": [{"id": str(s), "crop": _crop(s, user)} for s in samples],
        })
    out.sort(key=lambda p: -p["photos"])
    return {"people": out}


async def _mine(db: AsyncSession, person_id: uuid.UUID, user: User) -> Any:
    row = (
        await db.execute(text("SELECT * FROM photo_people WHERE id = :p AND user_id = :u"), {"p": person_id, "u": user.id})
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.get("/people/{person_id}")
async def get_person(
    person_id: uuid.UUID, before: str | None = None, limit: int = Query(default=150, ge=1, le=500),
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.photos.router import _cursor, _item, _uncursor

    p = await _mine(db, person_id, user)
    table, col = _obs_table(p.kind)
    ids = select(text("file_id")).select_from(text(table)).where(text(f"{col} = :pid").bindparams(pid=person_id))
    q = (
        select(PhotoAsset, UserFile, FileMedia)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
        .where(in_library(user.id), PhotoAsset.archived_at.is_(None), PhotoAsset.file_id.in_(ids))
    )
    if before:
        when, fid = _uncursor(before)
        q = q.where(or_(PhotoAsset.taken_local < when, and_(PhotoAsset.taken_local == when, PhotoAsset.file_id < fid)))
    rows = (
        await db.execute(
            q.order_by(PhotoAsset.taken_local.desc(), PhotoAsset.file_id.desc()).limit(limit + 1)
        )
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    info = next((x for x in await _list(db, user, p.kind, hidden=True) if x["id"] == str(person_id)), None)
    return {
        "person": info or {"id": str(person_id), "name": p.name, "hidden": p.hidden, "species": p.species, "photos": 0,
                           "me": p.linked_user_id == user.id, "cover": None},
        "kind": p.kind,
        "items": [_item(a, r, m, user) for a, r, m in rows],
        "next_cursor": _cursor(rows[-1][0].taken_local, rows[-1][0].file_id) if more and rows else None,
    }


class PersonPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    hidden: bool | None = None
    cover_id: uuid.UUID | None = None
    # "This is me" (true) / not me (false).
    me: bool | None = None
    # Memories of them (PH-5): false = "don't show me memories of them".
    memories: bool | None = None


@router.patch("/people/{person_id}")
async def patch_person(
    person_id: uuid.UUID, body: PersonPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    p = await _mine(db, person_id, user)
    sets: dict[str, Any] = {}
    fields = body.model_fields_set
    if "name" in fields:
        sets["name"] = (body.name or "").strip() or None
    if body.hidden is not None:
        sets["hidden"] = body.hidden
    if "cover_id" in fields:
        sets["cover_id"] = body.cover_id
    if body.memories is not None:
        from app.photos import memories

        sets["memories_hidden"] = not body.memories
        await memories.forget_fresh(user.id)
    if body.me is not None:
        if p.kind != "person":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only a person can be you.")
        if body.me:
            # Only one of your people is you.
            await db.execute(
                text("UPDATE photo_people SET linked_user_id = NULL WHERE user_id = :u AND linked_user_id = :u"),
                {"u": user.id},
            )
        sets["linked_user_id"] = user.id if body.me else None
    if sets:
        assign = ", ".join(f"{k} = :{k}" for k in sets)
        await db.execute(text(f"UPDATE photo_people SET {assign}, updated_at = now() WHERE id = :p"), {**sets, "p": person_id})
    await db.commit()
    info = next((x for x in await _list(db, user, p.kind, hidden=True) if x["id"] == str(person_id)), None)
    return info or {"id": str(person_id)}


class MergeBody(BaseModel):
    into: uuid.UUID


@router.post("/people/{person_id}/merge")
async def merge_people(
    person_id: uuid.UUID, body: MergeBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    src = await _mine(db, person_id, user)
    dst = await _mine(db, body.into, user)
    if src.id == dst.id or src.kind != dst.kind:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Those can't be merged.")
    moved = await people.merge(db, src.id, dst.id)
    await db.commit()
    return {"moved": moved, "into": str(dst.id)}


@router.get("/files/{file_id}/people")
async def people_in_photo(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """The faces (if faces are on) and animals in one of your photos, each
    with who it is — for the info panel's chips and "who is this?"."""
    row = await db.get(UserFile, file_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    out = []
    faces_on = bool((user.settings or {}).get("photos_faces"))
    for kind, table, col in (("person", "photo_faces", "person_id"), ("pet", "photo_animals", "pet_id")):
        if kind == "person" and not faces_on:
            continue
        extra = ", o.species" if kind == "pet" else ", NULL AS species"
        for r in (
            await db.execute(
                text(
                    f"SELECT o.id, o.box_x, o.box_y, o.box_w, o.box_h, o.assigned_by, p.id AS pid, p.name, p.hidden{extra} "
                    f"FROM {table} o LEFT JOIN photo_people p ON p.id = o.{col} WHERE o.file_id = :f ORDER BY o.box_x"
                ),
                {"f": file_id},
            )
        ).all():
            out.append({
                "id": str(r.id), "kind": kind, "species": r.species,
                "box": {"x": r.box_x, "y": r.box_y, "w": r.box_w, "h": r.box_h},
                "crop": _crop(r.id, user),
                "person": {"id": str(r.pid), "name": r.name, "hidden": r.hidden} if r.pid else None,
                "confirmed": r.assigned_by == "user",
            })
    return {"observations": out}


class RelationshipBody(BaseModel):
    label: str | None = Field(default=None, max_length=60)


@router.put("/people/{person_id}/relationship")
async def put_relationship(
    person_id: uuid.UUID, body: RelationshipBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """Who they are to you — your words, seen by nobody else."""
    p = await _mine(db, person_id, user)
    if p.kind != "person":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Relationships are for people.")
    await people.set_relationship(db, user.id, person_id, body.label)
    await db.commit()
    label = (body.label or "").strip() or None
    return {"relationship": label, "kind": people.relation_kind(label) if label else None}


@router.get("/people/{person_id}/faces")
async def person_faces(
    person_id: uuid.UUID, offset: int = Query(default=0, ge=0), limit: int = Query(default=120, ge=1, le=500),
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Each face of theirs (or each photo of a pet), newest photo first."""
    p = await _mine(db, person_id, user)
    table, col = _obs_table(p.kind)
    rows = (
        await db.execute(
            text(
                f"SELECT o.id, o.file_id, o.assigned_by FROM {table} o JOIN photo_assets a ON a.file_id = o.file_id "
                f"JOIN files fl ON fl.id = o.file_id WHERE o.{col} = :p AND fl.trashed_at IS NULL "
                f"ORDER BY a.taken_local DESC, o.id LIMIT :n OFFSET :o"
            ),
            {"p": person_id, "n": limit + 1, "o": offset},
        )
    ).all()
    return {
        "faces": [
            {"id": str(r.id), "file_id": str(r.file_id), "crop": _crop(r.id, user), "confirmed": r.assigned_by == "user"}
            for r in rows[:limit]
        ],
        "more": len(rows) > limit,
    }


class SplitBody(BaseModel):
    observation_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)
    into: uuid.UUID | None = None
    name: str | None = Field(default=None, max_length=120)


@router.post("/people/{person_id}/split")
async def split_person(
    person_id: uuid.UUID, body: SplitBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    p = await _mine(db, person_id, user)
    if body.into is not None:
        target = await _mine(db, body.into, user)
        if target.kind != p.kind or target.id == p.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "They can't be moved there.")
    into = await people.split(db, user.id, person_id, body.observation_ids, body.into, body.name, p.kind)
    await db.commit()
    return {"into": str(into)}


class AssignBody(BaseModel):
    person_id: uuid.UUID | None = None
    name: str | None = Field(default=None, max_length=120)


async def _observation(db: AsyncSession, obs_id: uuid.UUID, user: User) -> tuple[str, Any]:
    for kind, table in (("person", "photo_faces"), ("pet", "photo_animals")):
        row = (await db.execute(text(f"SELECT * FROM {table} WHERE id = :o AND user_id = :u"), {"o": obs_id, "u": user.id})).first()
        if row is not None:
            return kind, row
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


async def _target(db: AsyncSession, user: User, kind: str, obs: Any, body: AssignBody) -> uuid.UUID:
    """Who "this is": an existing one, or one by name (yours of that name,
    else a new one)."""
    if body.person_id is not None:
        target = await _mine(db, body.person_id, user)
        if target.kind != kind:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That's a pet, not a person (or the other way round).")
        pid = target.id
    elif body.name and body.name.strip():
        name = body.name.strip()
        pid = await db.scalar(
            text("SELECT id FROM photo_people WHERE user_id = :u AND kind = :k AND lower(name) = lower(:n) LIMIT 1"),
            {"u": user.id, "k": kind, "n": name},
        )
        if pid is None:
            pid = await db.scalar(
                text("INSERT INTO photo_people (user_id, kind, species, name) VALUES (:u, :k, :s, :n) RETURNING id"),
                {"u": user.id, "k": kind, "s": getattr(obs, "species", None), "n": name},
            )
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Say who it is.")
    return pid


@router.post("/faces/{obs_id}/person")
async def set_person(
    obs_id: uuid.UUID, body: AssignBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """"This is …": an existing person (or pet), or a new one by name — or
    the one of that name already in your library."""
    kind, obs = await _observation(db, obs_id, user)
    pid = await _target(db, user, kind, obs, body)
    if kind == "person":
        await people.assign(db, obs_id, pid)
    else:
        await people.assign_animal(db, obs_id, pid)
    await db.commit()
    return {"person_id": str(pid)}


class AssignManyBody(AssignBody):
    observation_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


@router.post("/faces/assign")
async def assign_many(
    body: AssignManyBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """"These are all …" — e.g. the dogs on a review card are your Bumi.
    The rest of them follow on their own (from these as examples)."""
    found = [await _observation(db, oid, user) for oid in dict.fromkeys(body.observation_ids)]
    kinds = {k for k, _ in found}
    if len(kinds) != 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Those are people and animals both.")
    kind = kinds.pop()
    pid = await _target(db, user, kind, found[0][1], body)
    for _k, obs in found:
        if kind == "person":
            await people.assign(db, obs.id, pid)
        else:
            await people.assign_animal(db, obs.id, pid)
    await db.commit()
    return {"person_id": str(pid), "assigned": len(found)}


class NotBody(BaseModel):
    person_id: uuid.UUID


@router.post("/faces/{obs_id}/not")
async def not_person(
    obs_id: uuid.UUID, body: NotBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    kind, _obs = await _observation(db, obs_id, user)
    await _mine(db, body.person_id, user)
    if kind == "person":
        await people.reject(db, obs_id, body.person_id)
    else:
        await people.reject_animal(db, obs_id, body.person_id)
    await db.commit()
    return {"ok": True}


__all__ = ["router"]

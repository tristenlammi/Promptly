"""The family library (PH-5) — your family, its people and what each shares.

    GET    /api/photos/family                   yours (or null)
    POST   /api/photos/family                   start one {name}
    PATCH  /api/photos/family                   rename (owner)
    POST   /api/photos/family/members           add someone {user_id} (owner)
    DELETE /api/photos/family/members/{uid}     remove them, or leave (the owner leaving ends it)
    PUT    /api/photos/family/share             what you put in {mode, since?, people?}
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()


def _err(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


async def _out(db: AsyncSession, user: User) -> dict[str, Any] | None:
    from app.photos import family

    m = await family.membership(db, user.id)
    if m is None:
        return None
    rows = (await db.execute(
        text(
            "SELECT fm.user_id, u.username, fm.share_mode, fm.share_since, fm.share_people, "
            "(SELECT count(*) FROM photo_family_items fi WHERE fi.family_id = fm.family_id AND fi.owner_id = fm.user_id) AS n "
            "FROM photo_family_members fm JOIN users u ON u.id = fm.user_id WHERE fm.family_id = :f ORDER BY fm.joined_at"
        ),
        {"f": m["family_id"]},
    )).mappings().all()
    # Names of the people your own share follows (theirs stay theirs).
    mine_people: list[dict[str, Any]] = []
    if m["share_people"]:
        mine_people = [
            {"id": str(i), "name": n}
            for i, n in (await db.execute(
                text("SELECT id, COALESCE(name, '') FROM photo_people WHERE id = ANY(CAST(:p AS uuid[])) AND user_id = :u"),
                {"p": [str(p) for p in m["share_people"]], "u": user.id},
            )).all()
        ]
    return {
        "id": str(m["family_id"]), "name": m["name"], "owner": m["owner_id"] == user.id,
        "members": [
            {"user_id": str(r["user_id"]), "username": r["username"], "owner": r["user_id"] == m["owner_id"],
             "you": r["user_id"] == user.id, "sharing": r["share_mode"], "photos": int(r["n"])}
            for r in rows
        ],
        "share": {
            "mode": m["share_mode"], "since": m["share_since"].isoformat() if m["share_since"] else None,
            "people": mine_people,
        },
    }


@router.get("")
async def get_family(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"family": await _out(db, user)}


class FamilyCreate(BaseModel):
    name: str = Field(default="Family", max_length=120)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_family(body: FamilyCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos import family

    try:
        await family.create(db, user, body.name)
    except family.FamilyError as exc:
        raise _err(exc) from exc
    await db.commit()
    return {"family": await _out(db, user)}


@router.patch("")
async def rename_family(body: FamilyCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos import family

    m = await family.membership(db, user.id)
    if m is None or m["owner_id"] != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the family's owner can rename it.")
    await db.execute(text("UPDATE photo_families SET name = :n WHERE id = :f"), {"n": body.name.strip()[:120] or "Family", "f": m["family_id"]})
    await db.commit()
    return {"family": await _out(db, user)}


class MemberAdd(BaseModel):
    user_id: uuid.UUID


@router.post("/members")
async def add_member(body: MemberAdd, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos import family

    try:
        await family.add_member(db, user, body.user_id)
    except family.FamilyError as exc:
        raise _err(exc) from exc
    await db.commit()
    try:
        from app.notifications.dispatch import notify_user

        await notify_user(
            user_id=body.user_id, category="invite", title=f"{user.username} added you to their family library",
            body="You see the photos family members share. Choose what of yours to share — nothing is, until you do.",
            url="/files/photos?view=family", actor_user_id=user.id,
        )
    except Exception:  # noqa: BLE001 — telling them never undoes it
        pass
    return {"family": await _out(db, user)}


@router.delete("/members/{member_id}")
async def remove_member(member_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos import family

    try:
        await family.remove_member(db, user, member_id)
    except family.FamilyError as exc:
        raise _err(exc) from exc
    await db.commit()
    return {"family": await _out(db, user)}


class ShareBody(BaseModel):
    mode: Literal["none", "all", "since", "people"]
    since: date | None = None
    people: list[uuid.UUID] = Field(default_factory=list, max_length=50)


@router.put("/share")
async def set_share(body: ShareBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """What of your library is in the family — applied at once."""
    from app.photos import family

    try:
        await family.set_share(db, user, body.mode, body.since, body.people)
    except family.FamilyError as exc:
        raise _err(exc) from exc
    await db.commit()
    return {"family": await _out(db, user)}


__all__ = ["router"]

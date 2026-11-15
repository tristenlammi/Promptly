"""Promptly Home for the people who live there (``/api/home``).

Off for the whole server until an admin turns it on (``app_settings.
home_enabled``); until then everything here is a 404. A home's devices are
seen only by its members: not by other homes, and not by an admin.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import codes, relay
from .models import ROLES, Home, HomeBox, HomeMember

router = APIRouter()

OFF = "Promptly Home isn't turned on"
MAX_HOMES = 5


async def enabled(db: AsyncSession) -> bool:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return bool(row is not None and getattr(row, "home_enabled", False))


async def _on(db: AsyncSession = Depends(get_db)) -> None:
    if not await enabled(db):
        raise HTTPException(status.HTTP_404_NOT_FOUND, OFF)


async def _claim_limit(request: Request) -> None:
    from limits import parse

    from app.rate_limit import rate_limit

    await rate_limit(parse("10/minute"), bucket="home_claim")(request)


async def _act_limit(request: Request) -> None:
    from limits import parse

    from app.rate_limit import rate_limit

    await rate_limit(parse("240/minute"), bucket="home_act")(request)


@router.websocket("/box/ws")
async def box_line(ws: WebSocket) -> None:
    """Where a box dials in. Not a person: the box's own key is the proof."""
    await relay.serve(ws)


@router.get("/available")
async def available(db: AsyncSession = Depends(get_db), _user: User = Depends(get_current_user)) -> dict[str, bool]:
    return {"available": await enabled(db)}


# ------------------------------------------------------------------ reading


async def _membership(db: AsyncSession, user: User, home_id: uuid.UUID) -> HomeMember:
    """This person's place in this home, or a 404 that says nothing about
    whether the home exists."""
    row = await db.get(HomeMember, (home_id, user.id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Home not found")
    return row


def _name(u: User) -> str:
    return (getattr(u, "display_name", None) or getattr(u, "full_name", None) or u.username or "").strip() or u.username


async def _devices(db: AsyncSession, home_id: uuid.UUID) -> dict[str, Any]:
    boxes = (await db.execute(select(HomeBox).where(HomeBox.home_id == home_id).order_by(HomeBox.created_at))).scalars().all()
    out_boxes: list[dict[str, Any]] = []
    entities: list[dict[str, Any]] = []
    areas: dict[str, dict[str, str]] = {}
    for n, box in enumerate(boxes, start=1):
        is_on, ents, box_areas = relay.view(box.id, box.snapshot)
        out_boxes.append(
            {
                "id": str(box.id),
                "name": box.name or (f"Box {n}" if len(boxes) > 1 else "Home box"),
                "online": is_on,
                "last_seen_at": box.last_seen_at.isoformat() if box.last_seen_at else None,
            }
        )
        for a in box_areas:
            areas.setdefault(a["id"], a)
        for e in ents:
            entities.append(
                {
                    **e,
                    "box_id": str(box.id),
                    "online": is_on,
                    "can_switch": e.get("domain") in relay.SWITCHABLE,
                }
            )
    entities.sort(key=lambda e: (str(e.get("area") or "~"), str(e.get("name") or "").lower()))
    return {"rev": relay.rev(home_id), "boxes": out_boxes, "areas": list(areas.values()), "entities": entities}


@router.get("", dependencies=[Depends(_on)])
async def my_homes(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    mine = (
        await db.execute(
            select(Home, HomeMember.role)
            .join(HomeMember, HomeMember.home_id == Home.id)
            .where(HomeMember.user_id == user.id)
            .order_by(Home.created_at)
        )
    ).all()
    homes: list[dict[str, Any]] = []
    for home, role in mine:
        members = (
            await db.execute(
                select(User, HomeMember.role)
                .join(HomeMember, HomeMember.user_id == User.id)
                .where(HomeMember.home_id == home.id)
                .order_by(HomeMember.created_at)
            )
        ).all()
        homes.append(
            {
                "id": str(home.id),
                "name": home.name,
                "role": role,
                "members": [{"id": str(u.id), "name": _name(u), "username": u.username, "role": r} for u, r in members],
                **await _devices(db, home.id),
            }
        )
    return {"homes": homes}


@router.get("/{home_id}/state", dependencies=[Depends(_on)])
async def state(
    home_id: uuid.UUID,
    after: int = Query(default=-1, ge=-1),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """What the page asks every couple of seconds while it's in front:
    nothing but the number when nothing changed."""
    await _membership(db, user, home_id)
    now = relay.rev(home_id)
    if after == now:
        return {"rev": now, "changed": False}
    return {"changed": True, **await _devices(db, home_id)}


# ------------------------------------------------------------------ claiming a box


class ClaimBody(BaseModel):
    code: str = Field(min_length=4, max_length=64)
    # Into a home you already have; otherwise a new one is made.
    home_id: uuid.UUID | None = None
    home_name: str | None = Field(default=None, max_length=80)


@router.post("/claim", dependencies=[Depends(_on), Depends(_claim_limit)])
async def claim(body: ClaimBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """The code on the card makes the box yours. One use: the code is gone
    once it has worked."""
    wrong = HTTPException(status.HTTP_404_NOT_FOUND, "That code doesn't match a box. Check the card and try again.")
    h = codes.claim_digest(body.code)
    if h is None:
        raise wrong
    box = (await db.execute(select(HomeBox).where(HomeBox.claim_hash == h).with_for_update())).scalar_one_or_none()
    if box is None or box.revoked_at is not None or box.home_id is not None:
        raise wrong
    if body.home_id is not None:
        member = await _membership(db, user, body.home_id)
        if member.role == "guest":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Ask someone who lives there to add the box.")
        home = await db.get(Home, body.home_id)
    else:
        count = len((await db.execute(select(HomeMember.home_id).where(HomeMember.user_id == user.id))).all())
        if count >= MAX_HOMES:
            raise HTTPException(status.HTTP_409_CONFLICT, "That's the most homes one person can be in.")
        home = Home(name=(body.home_name or "").strip() or f"{_name(user)}'s home", owner_id=user.id)
        db.add(home)
        await db.flush()
        db.add(HomeMember(home_id=home.id, user_id=user.id, role="owner"))
    assert home is not None
    box.home_id = home.id
    box.claim_hash = None
    box.claimed_by = user.id
    box.claimed_at = datetime.now(timezone.utc)
    box.snapshot = None
    await db.commit()
    await relay.tell(box.id, home.id)
    relay.bump(home.id)
    return {"home_id": str(home.id), "box_id": str(box.id), "online": relay.online(box.id)}


# ------------------------------------------------------------------ switching things


class ActBody(BaseModel):
    box_id: uuid.UUID
    entity_id: str = Field(min_length=3, max_length=200, pattern=r"^[a-z0-9_]+\.[a-z0-9_]+$")
    action: str


@router.post("/{home_id}/act", dependencies=[Depends(_on), Depends(_act_limit)])
async def act(home_id: uuid.UUID, body: ActBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _membership(db, user, home_id)
    box = await db.get(HomeBox, body.box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    if body.action not in relay.ACTIONS or body.entity_id.split(".", 1)[0] not in relay.SWITCHABLE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That can't be switched from here yet.")
    live = relay.link(box.id)
    if live is None or body.entity_id not in live.entities:
        raise HTTPException(status.HTTP_409_CONFLICT, "The home box is offline. Check it has power and internet.")
    # The wait for the box's answer mustn't hold a database connection.
    await db.close()
    try:
        await relay.call(box.id, body.entity_id, body.action)
    except relay.BoxOffline as e:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "The home box didn't answer. Try again.") from e
    except relay.BoxSaidNo as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return {"ok": True}


# ------------------------------------------------------------------ looking after a home


async def _owner(db: AsyncSession, user: User, home_id: uuid.UUID) -> Home:
    member = await _membership(db, user, home_id)
    if member.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the home's owner can do that.")
    home = await db.get(Home, home_id)
    assert home is not None
    return home


class HomePatch(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.patch("/{home_id}", dependencies=[Depends(_on)])
async def rename_home(home_id: uuid.UUID, body: HomePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    home = await _owner(db, user, home_id)
    home.name = body.name.strip()
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


class MemberBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    role: str = "adult"


@router.post("/{home_id}/members", dependencies=[Depends(_on)])
async def add_member(home_id: uuid.UUID, body: MemberBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _owner(db, user, home_id)
    if body.role not in ROLES or body.role == "owner":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick adult or guest.")
    other = (await db.execute(select(User).where(User.username == body.username.strip().lstrip("@")))).scalar_one_or_none()
    if other is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nobody here has that username.")
    row = await db.get(HomeMember, (home_id, other.id))
    if row is None:
        db.add(HomeMember(home_id=home_id, user_id=other.id, role=body.role))
    elif row.role != "owner":
        row.role = body.role
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


@router.delete("/{home_id}/members/{user_id}", dependencies=[Depends(_on)])
async def remove_member(home_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """The owner removes someone; anyone but the owner can leave."""
    me = await _membership(db, user, home_id)
    if user_id != user.id and me.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the home's owner can do that.")
    row = await db.get(HomeMember, (home_id, user_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "They aren't in this home.")
    if row.role == "owner":
        raise HTTPException(status.HTTP_409_CONFLICT, "The owner can't leave their own home.")
    await db.delete(row)
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


class BoxPatch(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.patch("/{home_id}/boxes/{box_id}", dependencies=[Depends(_on)])
async def rename_box(home_id: uuid.UUID, box_id: uuid.UUID, body: BoxPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _owner(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    box.name = body.name.strip()
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


@router.delete("/{home_id}/boxes/{box_id}", dependencies=[Depends(_on)])
async def release_box(home_id: uuid.UUID, box_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, str]:
    """Take a box out of this home, to move it or give it away. It forgets
    this home's devices and gets a fresh code, shown once, for whoever
    claims it next."""
    await _owner(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    code = codes.new_claim_code()
    box.home_id = None
    box.name = None
    box.snapshot = None
    box.claimed_by = None
    box.claimed_at = None
    box.claim_hash = codes.claim_digest(code)
    await db.commit()
    await relay.tell(box.id, None)
    relay.bump(home_id)
    return {"claim_code": code}

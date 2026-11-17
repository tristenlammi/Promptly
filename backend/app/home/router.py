"""Promptly Home for the people who live there (``/api/home``).

Off for the whole server until an admin turns it on (``app_settings.
home_enabled``); until then everything here is a 404. A home's devices are
seen only by its members: not by other homes, and not by an admin.
"""
from __future__ import annotations

import base64
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import builtin, codes, manage, music, relay
from .models import Home, HomeBox, HomeMember

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
        is_on, is_live, ents, box_areas = relay.view(box.id, box.snapshot)
        out_boxes.append(
            {
                "id": str(box.id),
                "name": box.name or ("This server" if builtin.is_builtin(box.id) else f"Box {n}" if len(boxes) > 1 else "Home box"),
                "online": is_on,
                "last_seen_at": box.last_seen_at.isoformat() if box.last_seen_at else None,
                "version": box.version,
                "added_at": box.claimed_at.isoformat() if box.claimed_at else None,
                # This server's own box: nothing to plug in, and it can't be moved.
                "builtin": builtin.is_builtin(box.id),
                # It has said what devices it has (a box is online a moment
                # before that; a fresh one takes a minute or two to set up).
                "ready": is_live,
                # Said once: things that had joined on their own and went back
                # under "Found on your network".
                "note": relay.note_of(box.id, box.snapshot),
            }
        )
        for a in box_areas:
            areas.setdefault(a["id"], a)
        for e in ents:
            entities.append(
                {
                    **e,
                    "box_id": str(box.id),
                    "online": is_live,
                    "can_switch": e.get("domain") in relay.SWITCHABLE,
                    # Unlocking, or opening a garage door: the page asks first
                    # (and so must anything that acts for a person later).
                    "careful": relay.ask_first(e),
                }
            )
    entities.sort(key=lambda e: (str(e.get("area") or "~"), str(e.get("name") or "").lower()))
    return {"rev": relay.rev(home_id), "boxes": out_boxes, "areas": list(areas.values()), "entities": entities}


@router.get("", dependencies=[Depends(_on)])
async def my_homes(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    if builtin.deployed() and user.role == "admin":
        # Home was turned on before this server had its own box (or its
        # home's owner is gone): the first admin to look gets it going.
        box = await db.get(HomeBox, builtin.BOX_ID)
        if box is None or box.home_id is None:
            await builtin.ensure_home(db, user)
            await db.commit()
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
                # Owners and co-owners set the home up; members use it.
                "can_manage": manage.can_manage(role),
                "members": [{"id": str(u.id), "name": _name(u), "username": u.username, "role": r} for u, r in members],
                **await _devices(db, home.id),
            }
        )
    # ``bundled``: this server has its own box, so there's nothing to plug in.
    return {"homes": homes, "bundled": builtin.deployed()}


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
        home = await _manager(db, user, body.home_id)
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
    action: str = Field(max_length=24)
    # What goes with it: a brightness, a temperature, a mode…
    value: Any = None
    # "Yes, unlock it": asked for by the page before a lock or a garage door.
    confirm: bool = False


@router.post("/{home_id}/act", dependencies=[Depends(_on), Depends(_act_limit)])
async def act(home_id: uuid.UUID, body: ActBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _membership(db, user, home_id)
    box = await db.get(HomeBox, body.box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    domain = body.entity_id.split(".", 1)[0]
    if body.action not in relay.ACTIONS.get(domain, ()):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That can't be done from here yet.")
    live = relay.link(box.id)
    entity = live.entities.get(body.entity_id) if live is not None else None
    if live is None or not live.got_snapshot or entity is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The home box is offline. Check it has power and internet.")
    if not relay.can_do(entity, body.action):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This device can't do that.")
    try:
        value = relay.clean_value(domain, body.action, body.value, entity, live.entities)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"That needs {e}.") from e
    if relay.needs_confirm(entity, body.action) and not body.confirm:
        raise HTTPException(status.HTTP_428_PRECONDITION_REQUIRED, "Say you're sure first.")
    await _ask_box(db, box.id, "do", {"entity": body.entity_id, "action": body.action, "value": value})
    return {"ok": True}


@router.get("/{home_id}/boxes/{box_id}/art/{entity_id}", dependencies=[Depends(_on), Depends(_act_limit)])
async def art(home_id: uuid.UUID, box_id: uuid.UUID, entity_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    """The picture of what a speaker is playing. The box fetches it; only a
    small image of a kind we know comes back, and never as anything else."""
    box = await _box_of(db, user, home_id, box_id)
    live = relay.link(box.id)
    entity = live.entities.get(entity_id) if live is not None and re.match(r"^media_player\.[a-z0-9_]+$", entity_id) else None
    if entity is None or not (entity.get("x") or {}).get("art"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No picture")
    try:
        got = await _ask_box(db, box.id, "art", {"entity": entity_id})
        kind = str((got or {}).get("type") or "")
        data = base64.b64decode(str((got or {}).get("b64") or ""), validate=True)
    except (HTTPException, ValueError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No picture") from None
    if kind not in relay.ART_TYPES or not data or len(data) > relay.ART_MAX:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No picture")
    return Response(content=data, media_type=kind, headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"})


async def _ask_box(db: AsyncSession, box_id: uuid.UUID, op: str, args: dict[str, Any], *, timeout: float = relay.CALL_S) -> Any:
    """One question to the box. The wait mustn't hold a database connection,
    so the session is closed first: do every check before calling this."""
    await db.close()
    try:
        return await relay.request(box_id, op, args, timeout=timeout)
    except relay.BoxOffline as e:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "The home box didn't answer. Check it has power and internet, then try again.") from e
    except relay.BoxSaidNo as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e


# ------------------------------------------------------------------ looking after a home


OWNER_ONLY = "Only the home's owner can do that."
RUNS_IT_ONLY = "Only the home's owner or a co-owner can do that."


async def _owner(db: AsyncSession, user: User, home_id: uuid.UUID) -> Home:
    """Choosing co-owners, passing the home on, deleting it."""
    member = await _membership(db, user, home_id)
    if member.role != manage.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, OWNER_ONLY)
    home = await db.get(Home, home_id)
    assert home is not None
    return home


async def _manager(db: AsyncSession, user: User, home_id: uuid.UUID) -> Home:
    """Setting the home up: the owner, or a co-owner the owner picked."""
    member = await _membership(db, user, home_id)
    if not manage.can_manage(member.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, RUNS_IT_ONLY)
    home = await db.get(Home, home_id)
    assert home is not None
    return home


class HomePatch(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.patch("/{home_id}", dependencies=[Depends(_on)])
async def rename_home(home_id: uuid.UUID, body: HomePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    home = await _manager(db, user, home_id)
    home.name = body.name.strip()
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


class MemberBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)


@router.post("/{home_id}/members", dependencies=[Depends(_on)])
async def add_member(home_id: uuid.UUID, body: MemberBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _manager(db, user, home_id)
    other = (await db.execute(select(User).where(User.username == body.username.strip().lstrip("@")))).scalar_one_or_none()
    if other is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nobody here has that username.")
    row = await db.get(HomeMember, (home_id, other.id))
    if row is None:
        count = len((await db.execute(select(HomeMember.home_id).where(HomeMember.user_id == other.id))).all())
        if count >= MAX_HOMES:
            raise HTTPException(status.HTTP_409_CONFLICT, "They're already in as many homes as one person can be.")
        db.add(HomeMember(home_id=home_id, user_id=other.id, role="member"))
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


@router.delete("/{home_id}/members/{user_id}", dependencies=[Depends(_on)])
async def remove_member(home_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """Anyone but the owner can leave. The owner removes anyone; a co-owner
    removes members (not the owner, and not another co-owner). The owner
    goes by passing the home on or deleting it."""
    me = await _membership(db, user, home_id)
    row = await db.get(HomeMember, (home_id, user_id)) if user_id != user.id else me
    if user_id != user.id:
        if not manage.can_manage(me.role):
            raise HTTPException(status.HTTP_403_FORBIDDEN, RUNS_IT_ONLY)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "They aren't in this home.")
        if me.role != manage.OWNER and row.role != manage.MEMBER:
            raise HTTPException(status.HTTP_403_FORBIDDEN, OWNER_ONLY)
    assert row is not None
    if row.role == manage.OWNER:
        raise HTTPException(status.HTTP_409_CONFLICT, "The owner can't just leave. Pass the home to someone in it, or delete it.")
    await db.delete(row)
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


class RoleBody(BaseModel):
    role: str = Field(pattern=r"^(coowner|member)$")


@router.patch("/{home_id}/members/{user_id}", dependencies=[Depends(_on)])
async def set_role(home_id: uuid.UUID, user_id: uuid.UUID, body: RoleBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """The owner makes someone a co-owner, or takes that back."""
    await _owner(db, user, home_id)
    row = await db.get(HomeMember, (home_id, user_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "They aren't in this home.")
    if row.role == manage.OWNER:
        raise HTTPException(status.HTTP_409_CONFLICT, "That's the owner. To change the owner, pass the home on.")
    row.role = body.role
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


class PassBody(BaseModel):
    user_id: uuid.UUID
    # Stay on as a co-owner, or leave the home as well.
    leave: bool = False


@router.put("/{home_id}/owner", dependencies=[Depends(_on)])
async def pass_home(home_id: uuid.UUID, body: PassBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """The owner hands the home to someone in it."""
    home = await _owner(db, user, home_id)
    try:
        await manage.pass_on(db, home, body.user_id, stay=not body.leave)
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "They aren't in this home.") from None
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


@router.delete("/{home_id}", dependencies=[Depends(_on)])
async def delete_home(home_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """The owner deletes the home: everyone is out of it, and its boxes
    forget its brands, sign-ins, linked music and rooms. ``waiting``: how
    many boxes couldn't be reached and will do that when they next connect
    (nothing on them is shown to anyone before then)."""
    home = await _owner(db, user, home_id)
    box_ids = await manage.wipe_home(db, home)
    await db.commit()
    await db.close()
    waiting = await manage.after_wipe(home_id, box_ids)
    return {"ok": True, "boxes": len(box_ids), "waiting": len(waiting)}


class BoxPatch(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.patch("/{home_id}/boxes/{box_id}", dependencies=[Depends(_on)])
async def rename_box(home_id: uuid.UUID, box_id: uuid.UUID, body: BoxPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    await _manager(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    box.name = body.name.strip()
    await db.commit()
    relay.bump(home_id)
    return {"ok": True}


@router.delete("/{home_id}/boxes/{box_id}", dependencies=[Depends(_on)])
async def release_box(home_id: uuid.UUID, box_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Take a box out of this home, to move it or give it away. It forgets
    this home's brands, sign-ins, linked music and rooms (now if it's
    connected, otherwise the moment it next is, before it shows anyone
    anything) and gets a fresh code, shown once, for whoever claims it
    next."""
    await _manager(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    if builtin.is_builtin(box.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "This box is part of the server, so it stays in this home.")
    code = await manage.release(db, box, new_code=True)
    assert code is not None
    await db.commit()
    await db.close()
    waiting = await manage.after_wipe(home_id, [box_id])
    return {"claim_code": code, "wiped": not waiting}


# ------------------------------------------------------------------ adding devices, rooms
#
# "Add a device" is Home Assistant's own set-up steps, done on the box and
# shown here in plain shapes (the box turns them into forms: fields, a
# "press the button on the bridge" pause, what went wrong). Whatever is typed
# into a step goes to the box in the body of one request and is passed on as
# it is: it isn't stored, and request bodies aren't logged.


async def _setup_limit(request: Request) -> None:
    from limits import parse

    from app.rate_limit import rate_limit

    await rate_limit(parse("120/minute"), bucket="home_setup")(request)


async def _box_of(db: AsyncSession, user: User, home_id: uuid.UUID, box_id: uuid.UUID) -> HomeBox:
    """A box of a home this person is in: for using the home."""
    await _membership(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    return box


async def _box_to_set_up(db: AsyncSession, user: User, home_id: uuid.UUID, box_id: uuid.UUID) -> HomeBox:
    """A box of a home this person runs (owner or co-owner): for adding and
    removing brands and devices, rooms, names, and music."""
    await _manager(db, user, home_id)
    box = await db.get(HomeBox, box_id)
    if box is None or box.home_id != home_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    return box


# Ids of Home Assistant's own things (a set-up, an entry, a room). The box
# puts some of them into a path, so never "." or "..": it starts with a
# letter, a digit or an underscore.
_ID = r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$"
SETUP = [Depends(_on), Depends(_setup_limit)]


@router.get("/{home_id}/boxes/{box_id}/setup/found", dependencies=SETUP)
async def setup_found(home_id: uuid.UUID, box_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    """What the box has noticed on the home's network and could set up."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    return {"found": await _ask_box(db, box.id, "flows.found", {})}


@router.get("/{home_id}/boxes/{box_id}/setup/brands", dependencies=SETUP)
async def setup_brands(home_id: uuid.UUID, box_id: uuid.UUID, q: str = Query(default="", max_length=60), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    return {"brands": await _ask_box(db, box.id, "brands", {"q": q.strip()})}


class StartBody(BaseModel):
    brand: str = Field(pattern=_ID)


@router.post("/{home_id}/boxes/{box_id}/setup", dependencies=SETUP)
async def setup_start(home_id: uuid.UUID, box_id: uuid.UUID, body: StartBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    return await _ask_box(db, box.id, "flows.start", {"brand": body.brand}, timeout=relay.SETUP_S)


@router.get("/{home_id}/boxes/{box_id}/setup/{flow_id}", dependencies=SETUP)
async def setup_get(home_id: uuid.UUID, box_id: uuid.UUID, flow_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, flow_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return await _ask_box(db, box.id, "flows.get", {"flow": flow_id}, timeout=relay.SETUP_S)


# What's typed into one step is a few fields. The box's line carries a
# megabyte at most: more than this would drop it for the whole home.
MAX_STEP_BYTES = 16 * 1024


def _too_big(given: dict[str, Any]) -> bool:
    import json

    try:
        return len(json.dumps(given)) > MAX_STEP_BYTES
    except (TypeError, ValueError):
        return True


class StepBody(BaseModel):
    # What was typed into this step. Passed to the box as it is.
    input: dict[str, Any] = Field(default_factory=dict)


@router.post("/{home_id}/boxes/{box_id}/setup/{flow_id}", dependencies=SETUP)
async def setup_step(home_id: uuid.UUID, box_id: uuid.UUID, flow_id: str, body: StepBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, flow_id) or len(body.input) > 60 or _too_big(body.input):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That step can't be sent.")
    return await _ask_box(db, box.id, "flows.step", {"flow": flow_id, "input": body.input}, timeout=relay.SETUP_S)


@router.delete("/{home_id}/boxes/{box_id}/setup/{flow_id}", dependencies=SETUP)
async def setup_abort(home_id: uuid.UUID, box_id: uuid.UUID, flow_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if re.match(_ID, flow_id):
        await _ask_box(db, box.id, "flows.abort", {"flow": flow_id})
    return {"ok": True}


@router.get("/{home_id}/boxes/{box_id}/connected", dependencies=SETUP)
async def connected(home_id: uuid.UUID, box_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    """The brands and bridges this home has set up."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    return {"connected": await _ask_box(db, box.id, "entries.list", {})}


@router.delete("/{home_id}/boxes/{box_id}/connected/{entry_id}", dependencies=SETUP)
async def disconnect(home_id: uuid.UUID, box_id: uuid.UUID, entry_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """Remove a brand or bridge, and with it the devices it brought."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, entry_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _ask_box(db, box.id, "entries.remove", {"entry": entry_id}, timeout=relay.SETUP_S)
    return {"ok": True}


# ------------------------------------------------------------------ music
#
# A box with a music service can have a streaming service linked to it, so
# the assistant can play music by name (``music.py``). Linking happens on the
# service's own site, with a short code: no password is typed into Promptly,
# and what the service hands back stays on the box. Anyone in the home sees
# what's linked; only its owner or a co-owner links and unlinks.


@router.get("/{home_id}/boxes/{box_id}/music", dependencies=SETUP)
async def music_status(home_id: uuid.UUID, box_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    """What can be linked, what is, and which speakers it plays to; or
    ``music: null`` for a box with no music service."""
    box = await _box_of(db, user, home_id, box_id)
    await db.close()
    try:
        return {"music": music.clean_status(await relay.request(box.id, "music.status", {}, timeout=relay.SETUP_S))}
    except relay.BoxOffline as e:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "The home box didn't answer. Check it has power and internet, then try again.") from e
    except relay.BoxSaidNo as e:
        return {"music": None, "why": str(e)[:200]}


class LinkBody(BaseModel):
    brand: str = Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")


@router.post("/{home_id}/boxes/{box_id}/music/link", dependencies=SETUP)
async def music_link(home_id: uuid.UUID, box_id: uuid.UUID, body: LinkBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if body.brand not in music.LINK_HOSTS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return music.clean_link(await _ask_box(db, box.id, "music.link.start", {"brand": body.brand}, timeout=relay.SETUP_S), body.brand)


@router.get("/{home_id}/boxes/{box_id}/music/link/{brand}/{flow_id}", dependencies=SETUP)
async def music_link_get(home_id: uuid.UUID, box_id: uuid.UUID, brand: str, flow_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if brand not in music.LINK_HOSTS or not re.match(_ID, flow_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return music.clean_link(await _ask_box(db, box.id, "music.link.get", {"flow": flow_id}, timeout=relay.SETUP_S), brand)


@router.delete("/{home_id}/boxes/{box_id}/music/link/{brand}/{flow_id}", dependencies=SETUP)
async def music_link_abort(home_id: uuid.UUID, box_id: uuid.UUID, brand: str, flow_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if re.match(_ID, flow_id):
        await _ask_box(db, box.id, "music.link.abort", {"flow": flow_id})
    return {"ok": True}


@router.delete("/{home_id}/boxes/{box_id}/music/sources/{source_id}", dependencies=SETUP)
async def music_unlink(home_id: uuid.UUID, box_id: uuid.UUID, source_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, source_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _ask_box(db, box.id, "music.unlink", {"source": source_id}, timeout=relay.SETUP_S)
    return {"ok": True}


class RoomBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.post("/{home_id}/boxes/{box_id}/rooms", dependencies=SETUP)
async def add_room(home_id: uuid.UUID, box_id: uuid.UUID, body: RoomBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Any:
    box = await _box_to_set_up(db, user, home_id, box_id)
    return await _ask_box(db, box.id, "areas.create", {"name": body.name.strip()})


class OrderBody(BaseModel):
    order: list[str] = Field(max_length=300)


@router.put("/{home_id}/boxes/{box_id}/rooms/order", dependencies=SETUP)
async def order_rooms(home_id: uuid.UUID, box_id: uuid.UUID, body: OrderBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """The order rooms are shown in, for everyone in the home."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    if any(not re.match(_ID, a) for a in body.order):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That order can't be saved.")
    await _ask_box(db, box.id, "areas.order", {"order": body.order})
    return {"ok": True}


class MergeBody(BaseModel):
    into: str = Field(pattern=_ID)


@router.post("/{home_id}/boxes/{box_id}/rooms/{area_id}/merge", dependencies=SETUP)
async def merge_rooms(home_id: uuid.UUID, box_id: uuid.UUID, area_id: str, body: MergeBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """Two rooms that are really one ("Lounge Room" and "Living Room"):
    everything in this one moves to the other, and this one goes."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, area_id) or area_id == body.into:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick two different rooms.")
    await _ask_box(db, box.id, "areas.merge", {"area": area_id, "into": body.into}, timeout=relay.SETUP_S)
    return {"ok": True}


class LightsBody(BaseModel):
    on: bool


@router.post("/{home_id}/boxes/{box_id}/rooms/{area_id}/lights", dependencies=[Depends(_on), Depends(_act_limit)])
async def room_lights(home_id: uuid.UUID, box_id: uuid.UUID, area_id: str, body: LightsBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """All of a room's lights, on or off."""
    box = await _box_of(db, user, home_id, box_id)
    live = relay.link(box.id)
    if not re.match(_ID, area_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if live is None or not live.got_snapshot:
        raise HTTPException(status.HTTP_409_CONFLICT, "The home box is offline. Check it has power and internet.")
    if not any(e.get("domain") == "light" and e.get("area") == area_id for e in live.entities.values()):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There are no lights in that room.")
    await _ask_box(db, box.id, "room.lights", {"area": area_id, "action": "turn_on" if body.on else "turn_off"})
    return {"ok": True}


@router.patch("/{home_id}/boxes/{box_id}/rooms/{area_id}", dependencies=SETUP)
async def rename_room(home_id: uuid.UUID, box_id: uuid.UUID, area_id: str, body: RoomBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, area_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _ask_box(db, box.id, "areas.rename", {"area": area_id, "name": body.name.strip()})
    return {"ok": True}


@router.delete("/{home_id}/boxes/{box_id}/rooms/{area_id}", dependencies=SETUP)
async def delete_room(home_id: uuid.UUID, box_id: uuid.UUID, area_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not re.match(_ID, area_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _ask_box(db, box.id, "areas.delete", {"area": area_id})
    return {"ok": True}


class PlaceBody(BaseModel):
    entities: list[str] = Field(min_length=1, max_length=200)
    # A room's id; "" takes them out of their room.
    area: str = Field(max_length=80)


@router.post("/{home_id}/boxes/{box_id}/devices/place", dependencies=SETUP)
async def place_devices(home_id: uuid.UUID, box_id: uuid.UUID, body: PlaceBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """Several devices into one room at once."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    if any(not re.match(r"^[a-z0-9_]+\.[a-z0-9_]+$", e) or len(e) > 200 for e in body.entities) or (body.area and not re.match(_ID, body.area)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Say which devices, and which room.")
    await _ask_box(db, box.id, "devices.place", {"entities": body.entities, "area": body.area}, timeout=relay.SETUP_S)
    return {"ok": True}


@router.delete("/{home_id}/boxes/{box_id}/note", dependencies=SETUP)
async def clear_note(home_id: uuid.UUID, box_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """"Got it": the one-time line about things that had joined on their own."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    live = relay.link(box.id)
    if live is not None:
        live.note = None
        relay.bump(home_id)
    await _ask_box(db, box.id, "note.clear", {})
    return {"ok": True}


class DeviceBody(BaseModel):
    # One of these says which: a device from a finished set-up, or a tile.
    device_id: str | None = Field(default=None, pattern=_ID)
    entity_id: str | None = Field(default=None, max_length=200, pattern=r"^[a-z0-9_]+\.[a-z0-9_]+$")
    name: str | None = Field(default=None, min_length=1, max_length=80)
    # A room's id; "" takes it out of its room.
    area: str | None = Field(default=None, max_length=80)


@router.patch("/{home_id}/boxes/{box_id}/devices", dependencies=SETUP)
async def update_device(home_id: uuid.UUID, box_id: uuid.UUID, body: DeviceBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, bool]:
    """Name a device, or put it in a room."""
    box = await _box_to_set_up(db, user, home_id, box_id)
    if not (body.device_id or body.entity_id) or (body.name is None and body.area is None) or (body.area and not re.match(_ID, body.area)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Say which device, and its name or room.")
    await _ask_box(db, box.id, "device.update", body.model_dump(exclude_none=True))
    return {"ok": True}

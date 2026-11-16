"""The home, for the assistant.

What the assistant (a chat, or a spoken turn on the phone) may see and do in
a home: the devices of the homes **this person is in**, and switching the
everyday ones (lights, plugs, fans, scenes, speakers). The same rules as the
Home page (``router.py::act``): an action is checked against what the device
says it can do, and its value is cleaned, before the box is asked.

Never from here: locks, garage doors, gates and alarms
(``relay.ask_first``). Those stay on the Home page, where the person is asked
"are you sure?" on the screen.

Nothing here reads who else is in a home, and an admin gets no more than
anyone: only their own homes.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import quick, relay
from .models import Home, HomeBox, HomeMember

logger = logging.getLogger("promptly.home.assistant")

# What the assistant switches. Everything else a home has can be looked at.
CONTROLLED = frozenset({"light", "switch", "input_boolean", "fan", "scene", "media_player"})
NOT_FROM_HERE = "That's one for the Home page: I don't open, unlock or disarm things."
PARKED = "I can't control that yet. It's on the Home page."
OFFLINE = "The home box is offline, so I can't reach it. Check it has power and internet."
NO_ANSWER = "The home box didn't answer. Check it has power and internet, then try again."


class CantDo(Exception):
    """Said to the person (or the model) as it is."""


async def has_home(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """Home is on for this server and this person is in a home."""
    from .router import enabled

    if not await enabled(db):
        return False
    return (await db.execute(select(HomeMember.home_id).where(HomeMember.user_id == user_id).limit(1))).first() is not None


async def devices_for(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    """Every device in the homes this person is in, with its room's name.
    ``live``: its box is connected and has said what it has (otherwise it's
    what the box last said, and can't be switched)."""
    from .router import enabled

    if not await enabled(db):
        return []
    rows = (
        await db.execute(
            select(Home, HomeBox)
            .join(HomeMember, HomeMember.home_id == Home.id)
            .join(HomeBox, HomeBox.home_id == Home.id)
            .where(HomeMember.user_id == user_id, HomeBox.revoked_at.is_(None))
            .order_by(Home.created_at, HomeBox.created_at)
        )
    ).all()
    out: list[dict[str, Any]] = []
    for home, box in rows:
        _online, live, entities, areas = relay.view(box.id, box.snapshot)
        names = {str(a.get("id")): str(a.get("name") or "") for a in areas}
        for e in entities:
            if not isinstance(e.get("id"), str) or not isinstance(e.get("domain"), str):
                continue
            out.append(
                {
                    **e,
                    "name": str(e.get("name") or e["id"]),
                    "box_id": box.id,
                    "home_id": home.id,
                    "home": home.name,
                    "room": names.get(str(e.get("area") or ""), ""),
                    "live": live,
                    "careful": relay.ask_first(e),
                }
            )
    return out


def _checked(device: dict[str, Any], action: str, value: Any) -> Any:
    """The value to send, or :class:`CantDo`. The rules of ``router.act``."""
    domain = str(device.get("domain"))
    if device.get("careful"):
        raise CantDo(NOT_FROM_HERE)
    if domain not in CONTROLLED:
        raise CantDo(PARKED)
    if action not in relay.ACTIONS.get(domain, ()):
        raise CantDo(f"{device['name']} can't do that.")
    live = relay.link(device["box_id"])
    entity = live.entities.get(device["id"]) if live is not None else None
    if live is None or not live.got_snapshot or entity is None:
        raise CantDo(OFFLINE)
    if not relay.can_do(entity, action):
        raise CantDo(f"{device['name']} can't do that.")
    try:
        return relay.clean_value(domain, action, value, entity, live.entities)
    except ValueError as e:
        raise CantDo(f"That needs {e}.") from e


async def act(device: dict[str, Any], action: str, value: Any = None) -> None:
    """Switch or set one device. No database connection is held while the
    box is asked: the caller has finished with its session."""
    cleaned = _checked(device, action, value)
    try:
        await relay.request(device["box_id"], "do", {"entity": device["id"], "action": action, "value": cleaned})
    except relay.BoxOffline as e:
        raise CantDo(NO_ANSWER) from e
    except relay.BoxSaidNo as e:
        raise CantDo(str(e)) from e


async def room_lights(box_id: uuid.UUID, area: str, on: bool) -> None:
    live = relay.link(box_id)
    if live is None or not live.got_snapshot:
        raise CantDo(OFFLINE)
    if not any(e.get("domain") == "light" and e.get("area") == area for e in live.entities.values()):
        raise CantDo("There are no lights in that room.")
    try:
        await relay.request(box_id, "room.lights", {"area": area, "action": "turn_on" if on else "turn_off"})
    except relay.BoxOffline as e:
        raise CantDo(NO_ANSWER) from e
    except relay.BoxSaidNo as e:
        raise CantDo(str(e)) from e


async def _step(step: quick.Step) -> None:
    if step.kind == "lights":
        await room_lights(step.box_id, step.area, step.action == "turn_on")
    elif step.device is not None:
        await act(step.device, step.action, step.value)


async def carry_out(plan: quick.Plan) -> tuple[bool, str]:
    """Do a plan's steps together; ``(it worked, what to say)``."""
    if plan.problem or not plan.steps:
        return (not plan.problem, plan.say)
    results = await asyncio.gather(*(_step(s) for s in plan.steps), return_exceptions=True)
    failed = [r for r in results if isinstance(r, BaseException)]
    for r in failed:
        if not isinstance(r, CantDo):
            logger.error("home: a quick command failed", exc_info=r)
    if not failed:
        return True, plan.say
    if len(failed) < len(results):
        return False, "Some of that didn't work. Have a look at the Home page."
    first = failed[0]
    return False, str(first) if isinstance(first, CantDo) else "That didn't work, something went wrong."


async def quick_command(user_id: uuid.UUID, text: str) -> tuple[bool, str] | None:
    """A simple device command, done without a model: ``(ok, say)``; or None
    when it isn't one (the model answers)."""
    from app.database import SessionLocal

    if not quick.maybe(text):
        return None
    async with SessionLocal() as db:
        devices = await devices_for(db, user_id)
    if not devices:
        return None
    plan = quick.parse(text, devices)
    if plan is None:
        return None
    return await carry_out(plan)


# ------------------------------------------------------------------ for the model's tools
def find(devices: list[dict[str, Any]], target: str, kinds: frozenset[str] | set[str] | None = None) -> list[dict[str, Any]]:
    """Devices a name could mean: an entity id, an exact name, then names
    that contain it. The tool acts only when this is one thing."""
    t = quick.key(target)
    raw = str(target or "").strip()
    pool = [d for d in devices if kinds is None or d["domain"] in kinds]
    by_id = [d for d in pool if d["id"] == raw]
    if by_id:
        return by_id
    exact = [d for d in pool if quick.key(d["name"]) == t]
    if exact:
        return exact
    return [d for d in pool if t and t in quick.key(d["name"])]


def rooms_called(devices: list[dict[str, Any]], target: str) -> list[tuple[uuid.UUID, uuid.UUID, str, str]]:
    """``(home, box, area id, room name)`` for rooms this could mean."""
    t = quick.key(target)
    for suffix in (" lights", " light", " room"):
        if t.endswith(suffix):
            t = t[: -len(suffix)]
    seen: dict[tuple[Any, Any, str], str] = {}
    for d in devices:
        if d.get("area") and d.get("room"):
            seen[(d["home_id"], d["box_id"], str(d["area"]))] = str(d["room"])
    exact = [(h, b, a, n) for (h, b, a), n in seen.items() if quick.key(n) in (t, f"{t} room")]
    return exact or [(h, b, a, n) for (h, b, a), n in seen.items() if t and t in quick.key(n)]

"""The steps and checks of a home automation, as the flow engine runs them.

``app/tasks/graph_runner.py`` calls :func:`act` for a step (switch a device,
a room's lights, play music) and :func:`check` for a true/false branch (the
time of day, a device's state). Each step is checked exactly as a tap on the
Home page is (``assistant.act``): what the device says it can do, a cleaned
value, and never a lock, garage door, gate or alarm.

Only ever for a home automation (``tasks.home_id``), and only this server's
main process can reach a home's box, so that is where these runs happen
(``automations.execute``).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.tasks.flow_graph import (
    FlowNode,
    HomeDeviceData,
    HomeLightsData,
    HomeMusicData,
    HomeStateData,
    NodeType,
    TimeWindowData,
)

from . import assistant, relay
from .models import Home, HomeBox

# What a step may switch: the everyday things, as the assistant does.
CONTROLLED = assistant.CONTROLLED
NOT_IN_AUTOMATIONS = "Locks, garage doors, gates and alarms can't be part of an automation."
GONE = "{name} isn't in this home any more."
DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
# A warmth in kelvin, as it's said.
_WHITES = {2700: "warm white", 3000: "soft white", 4000: "white", 5500: "cool white", 6500: "daylight"}


class StepFailed(Exception):
    """Why a step didn't work, in words for the person."""


def _uuid(raw: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return None


async def device(db: AsyncSession, home_id: uuid.UUID, box: Any, entity: str, name: str = "") -> dict[str, Any]:
    """One device of this home as ``assistant.act`` takes it, or
    :class:`StepFailed`. From what its box says now, or last said."""
    called = name or "That device"
    box_id = _uuid(box)
    row = await db.get(HomeBox, box_id) if box_id is not None else None
    if row is None or row.home_id != home_id or row.revoked_at is not None:
        raise StepFailed(GONE.format(name=called))
    home = await db.get(Home, home_id)
    _online, live, entities, areas = relay.view(row.id, row.snapshot)
    found = next((e for e in entities if e.get("id") == entity), None)
    if found is None:
        raise StepFailed(GONE.format(name=called))
    rooms = {str(a.get("id")): str(a.get("name") or "") for a in areas}
    return {
        **found,
        "name": str(found.get("name") or name or entity),
        "box_id": row.id,
        "home_id": home_id,
        "home": home.name if home is not None else "",
        "room": rooms.get(str(found.get("area") or ""), ""),
        "live": live,
        "careful": relay.ask_first(found),
    }


def _colour(value: dict[str, Any]) -> str:
    from . import quick

    bits: list[str] = []
    if isinstance(value.get("bri"), int):
        bits.append(f"{value['bri']}%")
    if isinstance(value.get("k"), int):
        bits.append(min(_WHITES.items(), key=lambda kv: abs(kv[0] - value["k"]))[1])
    if isinstance(value.get("rgb"), list):
        named = next((n for n, rgb in quick.COLOURS.items() if rgb == value["rgb"]), None)
        bits.append(named or "a colour")
    return ", ".join(bits)


def did(domain: str, action: str, value: Any) -> str:
    """What a step did, in a couple of words ("turned on", "volume 40")."""
    if action == "turn_on":
        return "turned on"
    if action == "turn_off":
        return "turned off"
    if action == "toggle":
        return "switched"
    if action == "set" and isinstance(value, dict):
        return f"set to {_colour(value)}"
    if action == "run":
        return "switched on"
    if action == "volume":
        return f"volume {value}"
    if action == "mute":
        return "muted" if value else "unmuted"
    if action == "speed":
        return f"speed {value}%"
    if action == "preset":
        return f"playing preset {value}"
    return {"play": "playing", "pause": "paused", "stop": "stopped", "next": "skipped on", "prev": "went back a song"}.get(action, action.replace("_", " "))


def will(domain: str, action: str, value: Any) -> str:
    """The same, as an instruction, for the list and the editor ("turn on")."""
    if action == "set" and isinstance(value, dict):
        return f"set to {_colour(value)}"
    return {
        "turn_on": "turn on", "turn_off": "turn off", "toggle": "switch", "run": "switch on", "play": "play", "pause": "pause",
        "stop": "stop", "next": "next song", "prev": "previous song", "volume": f"volume {value}", "mute": "mute" if value else "unmute",
        "speed": f"speed {value}%", "preset": f"play preset {value}",
    }.get(action, action.replace("_", " "))


def check_step(dev: dict[str, Any], action: str, value: Any) -> Any:
    """A step's value, cleaned, or :class:`StepFailed`: the rules of a tap on
    the Home page, without needing the box to be online (saving a flow)."""
    domain = str(dev.get("domain"))
    if dev.get("careful"):
        raise StepFailed(NOT_IN_AUTOMATIONS)
    if domain not in CONTROLLED:
        raise StepFailed(f"{dev['name']} can't be used in an automation yet.")
    if action not in relay.ACTIONS.get(domain, ()) or (domain, action) in (("media_player", "join"), ("media_player", "unjoin"), ("media_player", "source")):
        raise StepFailed(f"{dev['name']} can't do that.")
    if not relay.can_do(dev, action):
        raise StepFailed(f"{dev['name']} can't do that.")
    try:
        return relay.clean_value(domain, action, value, dev, None)
    except ValueError as e:
        raise StepFailed(f"{dev['name']} needs {e}.") from e


async def _play(dev: dict[str, Any], data: HomeMusicData) -> str:
    from . import music

    if data.uri:
        await assistant.music_play(dev, data.uri, bool(data.shuffle))
        return f"playing {data.label or 'the music you picked'}"
    about = music.topic(data.query) if data.query.strip() else ""
    picked = None
    if about:
        picked = music.pick_mix(await assistant.music_search(dev["box_id"], about, ["playlist", "artist", "track"]), about)
        if picked is None:
            raise StepFailed(f"The music service found nothing for “{about}”.")
    else:
        picked = music.pick_any(await assistant.music_suggest(dev["box_id"]))
        if picked is None:
            picked = music.pick_mix(await assistant.music_search(dev["box_id"], "top hits", ["playlist"]), "hits")
        if picked is None:
            raise StepFailed("There was nothing to play: nothing has been played here before. Say what kind of music in this step.")
    item, grow = picked
    await assistant.music_play(dev, item["uri"], shuffle=not grow and item["kind"] in ("playlist", "artist"), mix=grow)
    return f"playing {music.describe_mix(item, grow)}"


async def act(node: FlowNode, *, home_id: uuid.UUID, db: AsyncSession) -> str:
    """Do one step; what it did, in words. No database connection is held
    while the box is asked."""
    try:
        if node.type == NodeType.HOME_LIGHTS:
            data = HomeLightsData.model_validate(node.data)
            box_id = _uuid(data.box)
            row = await db.get(HomeBox, box_id) if box_id is not None else None
            if row is None or row.home_id != home_id or row.revoked_at is not None:
                raise StepFailed(GONE.format(name=data.name or "That room"))
            await db.commit()
            await assistant.room_lights(row.id, data.area, bool(data.on))
            return f"{data.name or 'Room'} lights: turned {'on' if data.on else 'off'}"
        if node.type == NodeType.HOME_MUSIC:
            music = HomeMusicData.model_validate(node.data)
            dev = await device(db, home_id, music.box, music.entity, music.name)
            await db.commit()
            if dev.get("careful") or not assistant.plays_music(dev):
                raise StepFailed(f"{dev['name']} can't play from a music service.")
            if isinstance(music.volume, int) and 0 <= music.volume <= 100:
                await assistant.act(dev, "volume", music.volume)
            return f"{dev['name']}: {await _play(dev, music)}"
        step = HomeDeviceData.model_validate(node.data)
        dev = await device(db, home_id, step.box, step.entity, step.name)
        await db.commit()
        value = check_step(dev, step.action, step.value)
        await assistant.act(dev, step.action, value)
        return f"{dev['name']}: {did(str(dev['domain']), step.action, value)}"
    except assistant.CantDo as e:
        raise StepFailed(str(e)) from e


def state_is(entity: dict[str, Any], wanted: str) -> bool:
    """Whether a device is in the state a check or trigger asks for. "on"
    also means a speaker that's playing, a door that's open, someone home."""
    now = str(entity.get("state") or "").lower()
    want = str(wanted or "on").lower()
    if want == "on":
        return now in ("on", "playing", "open", "home", "unlocked", "heat", "cool", "auto", "dry", "fan_only", "heat_cool", "cleaning")
    if want == "off":
        return now in ("off", "idle", "paused", "standby", "closed", "not_home", "locked", "docked")
    return now == want


def in_window(data: TimeWindowData, now: datetime) -> bool:
    """``now`` is already in the right time zone."""

    def minutes(hhmm: str, fallback: int) -> int:
        try:
            h, m = hhmm.split(":", 1)
            return (int(h) % 24) * 60 + (int(m) % 60)
        except (ValueError, AttributeError):
            return fallback

    start, end = minutes(data.start, 0), minutes(data.end, 24 * 60 - 1)
    at = now.hour * 60 + now.minute
    days = {d for d in data.days if isinstance(d, int) and 0 <= d <= 6}

    def on(day: int) -> bool:
        return not days or day % 7 in days

    if start == end:  # the whole day
        return on(now.weekday())
    if start < end:
        return on(now.weekday()) and start <= at < end
    # Over midnight: 22:00–06:00. The day is the one the window started on.
    if at >= start:
        return on(now.weekday())
    if at < end:
        return on(now.weekday() - 1)
    return False


async def check(node: FlowNode, *, home_id: uuid.UUID, db: AsyncSession, now: datetime, tz_name: str) -> tuple[bool, str]:
    """A true/false branch: ``(result, what it found, in words)``."""
    if node.type == NodeType.TIME_WINDOW:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        data = TimeWindowData.model_validate(node.data)
        try:
            zone = ZoneInfo(data.timezone or tz_name)
        except (ZoneInfoNotFoundError, ValueError):
            zone = ZoneInfo("UTC")
        local = now.astimezone(zone)
        yes = in_window(data, local)
        return yes, f"It's {local.strftime('%H:%M')} on {DAYS[local.weekday()]}: {'inside' if yes else 'outside'} {data.start}–{data.end}"
    data2 = HomeStateData.model_validate(node.data)
    dev = await device(db, home_id, data2.box, data2.entity, data2.name)
    await db.commit()
    if not dev.get("live"):
        raise StepFailed(assistant.OFFLINE)
    if str(dev.get("state") or "") in ("unavailable", "unknown", ""):
        raise StepFailed(f"{dev['name']} isn't reachable, so its state can't be checked.")
    yes = state_is(dev, data2.state)
    return yes, f"{dev['name']} is {str(dev.get('state')).replace('_', ' ')}: {'yes' if yes else 'no'}"

"""The line to each box.

A box's connector dials **out** to ``/api/home/box/ws`` and keeps the socket
open, so nothing is opened on the home's router. This module holds those
sockets and what each box last said about its devices, in this process's
memory (one uvicorn worker, see CLAUDE.md). No database connection is held
while a socket idles: the few reads and writes use their own short sessions.

Protocol (JSON text frames, each with a ``t``)::

    box  -> {"t":"hello","box":"<uuid>","key":"<key>","v":"<connector version>"}
    srv  -> {"t":"welcome","claimed":true|false,"ping":25}
    box  -> {"t":"snapshot","areas":[{"id","name"}],"entities":[Entity...],"note"?:Note}
    box  -> {"t":"state","e":Entity}            one entity changed
    box  -> {"t":"gone","id":"light.x"}         one entity removed
    box  -> {"t":"down"}                        Home Assistant on the box went away
                                                (restarting); a snapshot follows when it's back
    srv  -> {"t":"req","id":"<req>","op":"<what>","args":{...}}
    box  -> {"t":"res","id":"<req>","ok":true,"data":...} | {"ok":false,"error":"..."}
    srv  -> {"t":"ping"}   box -> {"t":"pong"}  (either side may send either)
    srv  -> {"t":"claimed"} | {"t":"released"}  told when it joins or leaves a home

    Entity = {"id","domain","name","state","area"?,"unit"?,"cls"?,"bri"?,"x"?,
              "dev"?: its device (several entities can be one device),
              "grp"?: true for several speakers that play as one}
    x (what a device's controls need; all optional) holds, among others:
      "can":   what it says it can do ("play","next","vol","src","group",
               "temp","fan","pos","stop","start","dock"…). When a device
               sends this, anything not in it is refused here.
      air con: "modes","target","cur","min","max","step","fans","fan","act",
               "last" (the mode it was last on in), and for ducted systems
               "sys" (its unit's entity id) and "zone": true on each zone
      speaker: "vol","muted","title","artist","src","srcs","members","art"
               (changes when the picture does; the picture comes by ``art``)
    Note   = {"n": how many, "what": "speakers"|"devices", "brands": [names]}:
             things that had joined the home on their own and were put back
             under "Found on your network". Said once; ``note.clear`` ends it.

``op`` is one of: ``do`` (switch or set one device), ``art`` (the picture of
what a speaker is playing: ``{"type","b64"}``), ``flows.found``,
``brands``, ``flows.start``, ``flows.get``, ``flows.step``, ``flows.abort``
(adding a device: Home Assistant's own set-up steps, in plain shapes),
``entries.list``, ``entries.remove``, ``areas.create``, ``areas.rename``,
``areas.delete``, ``areas.merge``, ``areas.order``, ``device.update``,
``devices.place`` (several into a room at once), ``room.lights`` (all of a
room's lights on or off), ``note.clear``.

Rooms are Promptly's: the page makes, names, merges and orders them. The
box keeps them (they are Home Assistant's areas underneath, which no one is
told). A brand's own rooms and zones of lights, and its bridges, never come
through as entities: the box leaves them out.

The box does the Home Assistant work and sends plain shapes; the server
never speaks Home Assistant. What someone types into a set-up step (a
password, a key) goes straight through to the box: it is not stored or
logged here.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("promptly.home.relay")

PING_S = 25.0
SILENT_S = 70.0  # nothing heard for this long: the line is dead
HELLO_S = 10.0
CALL_S = 8.0
# Setting a device up can mean the box talking to it, or to its maker's cloud.
SETUP_S = 45.0
MAX_ANSWER = 512 * 1024
MAX_FRAME = 512 * 1024
MAX_ENTITIES = 3000
MAX_AREAS = 300
# Wrong-key hellos from one address before it's turned away for a while.
MAX_BAD_HELLOS = 10
BAD_WINDOW_S = 600.0

CLOSE_BAD = 4401
CLOSE_REVOKED = 4403
CLOSE_REPLACED = 4409
CLOSE_BUSY = 4429

# What a page may be shown: any kind of device the box sends (it leaves out
# Home Assistant's own odds and ends). One we have no controls for is shown
# with its name and what it says. And what a tap on a tile may switch.
_DOMAIN = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
# Home Assistant's own odds and ends, which are nobody's device (the box
# leaves them out too: ``HIDDEN`` in the connector).
NEVER = frozenset({
    "automation", "script", "person", "zone", "sun", "update", "tts", "stt", "conversation", "notify", "device_tracker", "weather",
    "calendar", "todo", "camera", "image", "event", "button", "number", "select", "text", "date", "time", "datetime",
    "input_number", "input_select", "input_text", "input_datetime", "input_button", "timer", "counter", "schedule", "tag",
    "wake_word", "assist_satellite", "ai_task", "geo_location", "image_processing", "homeassistant", "group", "persistent_notification",
})
SWITCHABLE = frozenset({"light", "switch", "input_boolean", "fan", "humidifier", "remote"})
# What each kind of device can be asked to do, and the value that goes with it.
_ON_OFF = frozenset({"turn_on", "turn_off", "toggle"})
ACTIONS: dict[str, frozenset[str]] = {
    "light": _ON_OFF | {"set"},
    "switch": _ON_OFF,
    "input_boolean": _ON_OFF,
    "humidifier": _ON_OFF,
    "remote": _ON_OFF,
    "fan": _ON_OFF | {"speed", "oscillate"},
    "cover": frozenset({"open", "close", "stop", "position"}),
    "valve": frozenset({"open", "close"}),
    # On is "the way it was last on" (the box remembers), never "its first mode".
    "climate": frozenset({"turn_on", "turn_off", "temperature", "mode", "fan"}),
    "media_player": frozenset({"turn_on", "turn_off", "play", "pause", "stop", "next", "prev", "volume", "mute", "source", "join", "unjoin"}),
    "lock": frozenset({"lock", "unlock"}),
    "vacuum": frozenset({"start", "pause", "stop", "dock", "locate"}),
    "scene": frozenset({"run"}),
}
# What a device must say it can do (``x.can``) for an action to go through.
# Checked only when the device says what it can do at all.
NEEDS: dict[tuple[str, str], str] = {
    ("media_player", "turn_on"): "on", ("media_player", "turn_off"): "off", ("media_player", "play"): "play",
    ("media_player", "pause"): "pause", ("media_player", "stop"): "stop", ("media_player", "next"): "next",
    ("media_player", "prev"): "prev", ("media_player", "volume"): "vol", ("media_player", "mute"): "mute",
    ("media_player", "source"): "src", ("media_player", "join"): "group", ("media_player", "unjoin"): "group",
    ("climate", "temperature"): "temp", ("climate", "fan"): "fan",
    ("cover", "open"): "open", ("cover", "close"): "close", ("cover", "stop"): "stop", ("cover", "position"): "pos",
    ("fan", "speed"): "speed", ("fan", "oscillate"): "osc",
    ("vacuum", "start"): "start", ("vacuum", "pause"): "pause", ("vacuum", "stop"): "stop", ("vacuum", "dock"): "dock", ("vacuum", "locate"): "locate",
}
# A door that lets someone in: the page asks "are you sure?" and says so here.
ENTRANCES = frozenset({"garage", "door", "gate"})
# Extras an entity may carry (``x``), by kind of value.
_X_NUM = frozenset({"k", "kmin", "kmax", "pct", "pos", "target", "cur", "min", "max", "step", "vol", "hum", "bat"})
_X_TEXT = {"title": 120, "artist": 120, "src": 60, "fan": 24, "act": 24, "last": 24, "art": 16, "sys": 200}
_X_BOOL = frozenset({"muted", "osc", "zone"})
# name -> (most items, longest item)
_X_LISTS = {"modes": (16, 24), "colours": (16, 24), "fans": (16, 24), "can": (24, 16), "srcs": (40, 60), "members": (32, 200)}
ART_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
ART_MAX = 300 * 1024


def ask_first(entity: dict[str, Any]) -> bool:
    """Something that lets a person in, or keeps one out: a lock, a garage
    door, a gate, an alarm. The page asks "are you sure?" before it opens
    one, and so must anything else that acts for a person (an assistant, an
    automation made by voice)."""
    domain = entity.get("domain")
    return domain in ("lock", "alarm_control_panel") or (domain == "cover" and entity.get("cls") in ENTRANCES)


def needs_confirm(entity: dict[str, Any], action: str) -> bool:
    if entity.get("domain") == "lock":
        return action == "unlock"
    return entity.get("domain") == "cover" and entity.get("cls") in ENTRANCES and action in ("open", "position")


def can_do(entity: dict[str, Any], action: str) -> bool:
    """Whether this device says it can do this. One that doesn't say what it
    can do (an older box) is taken at its word."""
    can = (entity.get("x") or {}).get("can")
    need = NEEDS.get((str(entity.get("domain")), action))
    return need is None or not isinstance(can, list) or need in can


def clean_value(domain: str, action: str, value: Any, entity: dict[str, Any], others: dict[str, dict[str, Any]] | None = None) -> Any:
    """The value for an action, checked; raises ValueError when it won't do.
    ``others`` is everything else on the same box (for grouping speakers)."""
    num = isinstance(value, (int, float)) and not isinstance(value, bool)
    x = entity.get("x") or {}
    if (domain, action) in (("media_player", "mute"), ("fan", "oscillate")):
        if not isinstance(value, bool):
            raise ValueError("on or off")
        return value
    if (domain, action) == ("media_player", "source"):
        if not isinstance(value, str) or value not in (x.get("srcs") or []):
            raise ValueError("one of its sources")
        return value
    if (domain, action) == ("climate", "fan"):
        if not isinstance(value, str) or value not in (x.get("fans") or []):
            raise ValueError("one of its fan speeds")
        return value
    if (domain, action) == ("media_player", "join"):
        # Speakers on the same box that can be grouped, and not itself.
        ids = [v for v in value if isinstance(v, str)] if isinstance(value, list) else []
        ok = [
            i for i in dict.fromkeys(ids[:16])
            if i != entity.get("id") and (others or {}).get(i, {}).get("domain") == "media_player" and can_do((others or {})[i], "join")
        ]
        if not ok or len(ok) != len(set(ids)):
            raise ValueError("speakers in this home that can be grouped")
        return ok
    if (domain, action) in (("fan", "speed"), ("cover", "position"), ("media_player", "volume")):
        if not num or not 0 <= value <= 100:
            raise ValueError("0 to 100")
        return int(value)
    if (domain, action) == ("climate", "temperature"):
        low = x.get("min") if isinstance(x.get("min"), (int, float)) else -50
        high = x.get("max") if isinstance(x.get("max"), (int, float)) else 100
        if not num or not low <= value <= high:
            raise ValueError("a temperature it can be set to")
        return float(value)
    if (domain, action) == ("climate", "mode"):
        modes = x.get("modes") or []
        if not isinstance(value, str) or value not in modes:
            raise ValueError("one of its modes")
        return value
    if (domain, action) == ("light", "set"):
        if not isinstance(value, dict):
            raise ValueError("what to set")
        out: dict[str, Any] = {}
        bri, k, rgb = value.get("bri"), value.get("k"), value.get("rgb")
        if isinstance(bri, (int, float)) and not isinstance(bri, bool) and 1 <= bri <= 100:
            out["bri"] = int(bri)
        if isinstance(k, (int, float)) and not isinstance(k, bool) and 1000 <= k <= 12000:
            out["k"] = int(k)
        if isinstance(rgb, list) and len(rgb) == 3 and all(isinstance(c, int) and not isinstance(c, bool) and 0 <= c <= 255 for c in rgb):
            out["rgb"] = rgb
        if not out:
            raise ValueError("a brightness, warmth or colour")
        return out
    return None


@dataclass
class Link:
    box_id: uuid.UUID
    home_id: uuid.UUID | None
    ws: WebSocket
    version: str = ""
    connected: float = field(default_factory=time.monotonic)
    heard: float = field(default_factory=time.monotonic)
    entities: dict[str, dict[str, Any]] = field(default_factory=dict)
    areas: list[dict[str, str]] = field(default_factory=list)
    note: dict[str, Any] | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    got_snapshot: bool = False
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, msg: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.ws.send_text(json.dumps(msg, separators=(",", ":")))


_links: dict[uuid.UUID, Link] = {}
# A home's revision: goes up whenever anything a page shows may have changed.
_revs: dict[uuid.UUID, int] = {}
_bad: dict[str, list[float]] = {}


def reset() -> None:
    """Tests."""
    _links.clear()
    _revs.clear()
    _bad.clear()


def bump(home_id: uuid.UUID | None) -> None:
    if home_id is not None:
        _revs[home_id] = _revs.get(home_id, 0) + 1


def rev(home_id: uuid.UUID) -> int:
    return _revs.get(home_id, 0)


def link(box_id: uuid.UUID) -> Link | None:
    return _links.get(box_id)


def online(box_id: uuid.UUID) -> bool:
    return box_id in _links


# ------------------------------------------------------------------ cleaning


def _text(v: Any, limit: int) -> str:
    return str(v)[:limit] if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ""


def clean_entity(raw: Any) -> dict[str, Any] | None:
    """Only the fields we know, at sizes we choose: a box is someone's
    computer and what it sends is shown to people."""
    if not isinstance(raw, dict):
        return None
    eid = _text(raw.get("id"), 200)
    domain = _text(raw.get("domain"), 32)
    if not eid or "." not in eid or not _DOMAIN.match(domain) or domain in NEVER or eid.split(".", 1)[0] != domain:
        return None
    out: dict[str, Any] = {
        "id": eid,
        "domain": domain,
        "name": _text(raw.get("name"), 120) or eid,
        "state": _text(raw.get("state"), 64),
    }
    for key, limit in (("area", 64), ("unit", 16), ("cls", 32), ("dev", 64)):
        v = _text(raw.get(key), limit)
        if v:
            out[key] = v
    if raw.get("grp") is True:
        out["grp"] = True
    bri = raw.get("bri")
    if isinstance(bri, (int, float)) and not isinstance(bri, bool) and 0 <= bri <= 100:
        out["bri"] = int(bri)
    x = _clean_x(raw.get("x"))
    if x:
        out["x"] = x
    return out


def _clean_x(raw: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    for key, v in raw.items():
        if key in _X_NUM and isinstance(v, (int, float)) and not isinstance(v, bool) and -100_000 <= v <= 100_000:
            out[key] = round(v, 2)
        elif key in _X_TEXT and isinstance(v, str) and v:
            out[key] = v[: _X_TEXT[key]]
        elif key in _X_BOOL and isinstance(v, bool):
            out[key] = v
        elif key in _X_LISTS and isinstance(v, list):
            most, longest = _X_LISTS[key]
            out[key] = [str(i)[:longest] for i in v[:most] if isinstance(i, (str, int)) and not isinstance(i, bool)]
        elif key == "rgb" and isinstance(v, list) and len(v) == 3 and all(isinstance(c, int) and 0 <= c <= 255 for c in v):
            out[key] = v
    return out


def clean_note(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    n = raw.get("n")
    brands = [_text(b, 60) for b in raw.get("brands") if _text(b, 60)][:6] if isinstance(raw.get("brands"), list) else []
    if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n <= 10_000 or (n == 0 and not brands):
        return None
    return {"n": n, "what": "speakers" if raw.get("what") == "speakers" else "devices", "brands": brands}


def note_of(box_id: uuid.UUID, saved: dict[str, Any] | None) -> dict[str, Any] | None:
    """What this box has to say once, live or from what it last said."""
    live = _links.get(box_id)
    if live is not None and live.got_snapshot:
        return live.note
    return clean_note((saved or {}).get("note")) if isinstance(saved, dict) else None


def _clean_areas(raw: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for a in raw if isinstance(raw, list) else []:
        if isinstance(a, dict) and _text(a.get("id"), 64) and _text(a.get("name"), 80):
            out.append({"id": _text(a["id"], 64), "name": _text(a["name"], 80)})
        if len(out) >= MAX_AREAS:
            break
    return out


# ------------------------------------------------------------------ the page's side


def view(box_id: uuid.UUID, saved: dict[str, Any] | None) -> tuple[bool, bool, list[dict[str, Any]], list[dict[str, str]]]:
    """``(box online, devices live, entities, areas)`` for one box. Live
    when it's connected and has said what it has; otherwise what it last
    said (``HomeBox.snapshot``), which can be looked at but not switched: a
    box that has just dialled in is online a moment before its devices are."""
    live = _links.get(box_id)
    if live is not None and live.got_snapshot:
        return True, True, list(live.entities.values()), list(live.areas)
    saved = saved if isinstance(saved, dict) else {}
    entities = [e for e in saved.get("entities") or [] if isinstance(e, dict)]
    areas = [a for a in saved.get("areas") or [] if isinstance(a, dict)]
    return live is not None, False, entities, areas


class BoxOffline(Exception):
    pass


class BoxSaidNo(Exception):
    pass


async def request(box_id: uuid.UUID, op: str, args: dict[str, Any] | None = None, *, timeout: float = CALL_S) -> Any:
    """Ask the box for one thing and wait for its answer."""
    live = _links.get(box_id)
    if live is None:
        raise BoxOffline()
    rid = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    live.pending[rid] = fut
    try:
        await live.send({"t": "req", "id": rid, "op": op, "args": args or {}})
        answer = await asyncio.wait_for(fut, timeout=timeout)
    except (asyncio.TimeoutError, WebSocketDisconnect, RuntimeError) as e:
        raise BoxOffline() from e
    finally:
        live.pending.pop(rid, None)
    if not (isinstance(answer, dict) and answer.get("ok") is True):
        raise BoxSaidNo(_text((answer or {}).get("error"), 300) or "The box couldn't do that.")
    return answer.get("data")


async def tell(box_id: uuid.UUID, home_id: uuid.UUID | None) -> None:
    """The box joined a home, or left one."""
    live = _links.get(box_id)
    if live is None:
        return
    bump(live.home_id)
    live.home_id = home_id
    bump(home_id)
    try:
        await live.send({"t": "claimed" if home_id else "released"})
    except Exception:  # noqa: BLE001 - it'll find out when it next dials in
        pass


async def drop(box_id: uuid.UUID, code: int = CLOSE_REVOKED) -> None:
    live = _links.get(box_id)
    if live is None:
        return
    try:
        await live.ws.close(code=code)
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ the box's side


def _too_many_bad(ip: str, now: float) -> bool:
    hits = [t for t in _bad.get(ip, []) if now - t < BAD_WINDOW_S]
    _bad[ip] = hits
    return len(hits) >= MAX_BAD_HELLOS


def _note_bad(ip: str, now: float) -> None:
    _bad.setdefault(ip, []).append(now)
    if len(_bad) > 5000:
        _bad.clear()


def _caller(ws: WebSocket) -> str:
    """Who is dialling, for counting wrong hellos. Behind nginx every socket's
    peer is nginx itself, so the peer alone would put the whole internet (and
    this server's own box) in one bucket: ten wrong hellos from anyone would
    turn every box away. The same spoof-resistant address the rate limiter
    uses: the forwarded one only when the peer is our own proxy."""
    from app.auth.audit import request_meta

    try:
        ip, _ua = request_meta(ws)  # type: ignore[arg-type]  # reads .headers and .client only
    except Exception:  # noqa: BLE001
        ip = ""
    return ip or (ws.client.host if ws.client else "?")


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # noqa: BLE001
        pass


async def _known_box(box_id: uuid.UUID, key: str) -> tuple[str, uuid.UUID | None]:
    """``("ok" | "bad" | "revoked", home_id)``. Its own short session."""
    from app.database import SessionLocal

    from . import builtin, codes
    from .models import HomeBox

    if builtin.is_builtin(box_id):
        # This server's own box: no row to prepare, no code to claim.
        if not builtin.key_ok(key):
            return "bad", None
        from .router import enabled

        async with SessionLocal() as db:
            box = await builtin.ensure_box(db)
            if box.home_id is None and await enabled(db):
                await builtin.ensure_home(db)  # Home was on before the box first dialled in
            await db.commit()
            return "ok", box.home_id
    async with SessionLocal() as db:
        box = await db.get(HomeBox, box_id)
        if box is None or not codes.same(box.key_hash, codes.digest(key)):
            return "bad", None
        if box.revoked_at is not None:
            return "revoked", None
        return "ok", box.home_id


async def _save(box_id: uuid.UUID, *, version: str | None = None, snapshot: dict[str, Any] | None = None) -> None:
    from app.database import SessionLocal

    from .models import HomeBox

    try:
        async with SessionLocal() as db:
            box = await db.get(HomeBox, box_id)
            if box is None:
                return
            box.last_seen_at = datetime.now(timezone.utc)
            if version is not None:
                box.version = version[:32]
            if snapshot is not None and box.home_id is not None:
                box.snapshot = snapshot
            await db.commit()
    except Exception:  # noqa: BLE001 - a missed "last seen" must not drop the line
        logger.exception("saving box %s failed", box_id)


def _snapshot_of(live: Link) -> dict[str, Any]:
    out = {
        "entities": list(live.entities.values()),
        "areas": live.areas,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if live.note:
        out["note"] = live.note
    return out


async def serve(ws: WebSocket) -> None:
    """One box's connection, start to finish."""
    await ws.accept()
    ip = _caller(ws)
    now = time.monotonic()
    if _too_many_bad(ip, now):
        await _close(ws, CLOSE_BUSY)
        return
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=HELLO_S)
        hello = json.loads(raw) if len(raw) <= 4096 else None
        box_id = uuid.UUID(str(hello["box"]))
        key = hello["key"]
        if hello.get("t") != "hello" or not isinstance(key, str) or not (16 <= len(key) <= 256):
            raise ValueError("hello")
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError, KeyError, TypeError, RuntimeError):
        _note_bad(ip, now)
        await _close(ws, CLOSE_BAD)
        return
    verdict, home_id = await _known_box(box_id, key)
    if verdict != "ok":
        _note_bad(ip, now)
        await _close(ws, CLOSE_REVOKED if verdict == "revoked" else CLOSE_BAD)
        return

    old = _links.get(box_id)
    if old is not None:  # the same box dialled again: the newer line wins
        await _close(old.ws, CLOSE_REPLACED)
    live = Link(box_id=box_id, home_id=home_id, ws=ws, version=_text(hello.get("v"), 32))
    _links[box_id] = live
    pinger = asyncio.create_task(_ping(live))
    try:
        await live.send({"t": "welcome", "claimed": home_id is not None, "ping": int(PING_S)})
        await _save(box_id, version=live.version)
        bump(home_id)
        while True:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=SILENT_S)
            live.heard = time.monotonic()
            if len(raw) > MAX_FRAME:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict):
                await _from_box(live, msg)
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
        pass
    except Exception:  # noqa: BLE001
        logger.exception("box %s line failed", box_id)
    finally:
        pinger.cancel()
        if _links.get(box_id) is live:
            _links.pop(box_id, None)
        for fut in live.pending.values():
            if not fut.done():
                fut.set_exception(WebSocketDisconnect())
        await _save(box_id, snapshot=_snapshot_of(live) if live.got_snapshot else None)
        bump(live.home_id)
        await _close(ws, 1000)


async def _ping(live: Link) -> None:
    try:
        while True:
            await asyncio.sleep(PING_S)
            await live.send({"t": "ping"})
    except Exception:  # noqa: BLE001 - the reader notices a dead line
        return


async def _from_box(live: Link, msg: dict[str, Any]) -> None:
    t = msg.get("t")
    if t == "snapshot":
        entities: dict[str, dict[str, Any]] = {}
        for raw in msg.get("entities") if isinstance(msg.get("entities"), list) else []:
            e = clean_entity(raw)
            if e is not None:
                entities[e["id"]] = e
            if len(entities) >= MAX_ENTITIES:
                break
        live.entities = entities
        live.areas = _clean_areas(msg.get("areas"))
        live.note = clean_note(msg.get("note"))
        first = not live.got_snapshot
        live.got_snapshot = True
        bump(live.home_id)
        if first:  # kept, so a crash before a clean goodbye still leaves the list
            await _save(live.box_id, snapshot=_snapshot_of(live))
    elif t == "state":
        e = clean_entity(msg.get("e"))
        if e is not None and (e["id"] in live.entities or len(live.entities) < MAX_ENTITIES):
            if live.entities.get(e["id"]) != e:
                live.entities[e["id"]] = e
                bump(live.home_id)
    elif t == "down":
        # The box is here but its Home Assistant isn't: what we hold is
        # last time's picture, to look at and not to switch.
        if live.got_snapshot:
            await _save(live.box_id, snapshot=_snapshot_of(live))
            live.got_snapshot = False
            bump(live.home_id)
    elif t == "gone":
        if live.entities.pop(_text(msg.get("id"), 200), None) is not None:
            bump(live.home_id)
    elif t == "res":
        fut = live.pending.get(_text(msg.get("id"), 64))
        if fut is not None and not fut.done():
            fut.set_result(msg)
    elif t == "ping":
        await live.send({"t": "pong"})

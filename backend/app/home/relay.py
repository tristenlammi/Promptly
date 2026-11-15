"""The line to each box.

A box's connector dials **out** to ``/api/home/box/ws`` and keeps the socket
open, so nothing is opened on the home's router. This module holds those
sockets and what each box last said about its devices, in this process's
memory (one uvicorn worker, see CLAUDE.md). No database connection is held
while a socket idles: the few reads and writes use their own short sessions.

Protocol (JSON text frames, each with a ``t``)::

    box  -> {"t":"hello","box":"<uuid>","key":"<key>","v":"<connector version>"}
    srv  -> {"t":"welcome","claimed":true|false,"ping":25}
    box  -> {"t":"snapshot","areas":[{"id","name"}],"entities":[Entity...]}
    box  -> {"t":"state","e":Entity}            one entity changed
    box  -> {"t":"gone","id":"light.x"}         one entity removed
    srv  -> {"t":"call","id":"<req>","entity":"light.x","action":"turn_on"|"turn_off"|"toggle"}
    box  -> {"t":"result","id":"<req>","ok":true} | {"ok":false,"error":"..."}
    srv  -> {"t":"ping"}   box -> {"t":"pong"}  (either side may send either)
    srv  -> {"t":"claimed"} | {"t":"released"}  told when it joins or leaves a home

    Entity = {"id","domain","name","state","area"?,"unit"?,"cls"?,"bri"?}

The box does the Home Assistant work and sends plain entities; the server
never speaks Home Assistant.
"""
from __future__ import annotations

import asyncio
import json
import logging
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

# What a page may be shown, and what it may switch.
SHOWN = frozenset(
    {"light", "switch", "input_boolean", "fan", "sensor", "binary_sensor", "climate", "cover", "lock", "media_player"}
)
SWITCHABLE = frozenset({"light", "switch", "input_boolean", "fan"})
ACTIONS = frozenset({"turn_on", "turn_off", "toggle"})


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
    if not eid or "." not in eid or domain not in SHOWN or eid.split(".", 1)[0] != domain:
        return None
    out: dict[str, Any] = {
        "id": eid,
        "domain": domain,
        "name": _text(raw.get("name"), 120) or eid,
        "state": _text(raw.get("state"), 64),
    }
    for key, limit in (("area", 64), ("unit", 16), ("cls", 32)):
        v = _text(raw.get(key), limit)
        if v:
            out[key] = v
    bri = raw.get("bri")
    if isinstance(bri, (int, float)) and not isinstance(bri, bool) and 0 <= bri <= 100:
        out["bri"] = int(bri)
    return out


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


async def call(box_id: uuid.UUID, entity_id: str, action: str) -> None:
    """Ask the box to do one thing and wait for its answer."""
    live = _links.get(box_id)
    if live is None:
        raise BoxOffline()
    rid = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    live.pending[rid] = fut
    try:
        await live.send({"t": "call", "id": rid, "entity": entity_id, "action": action})
        answer = await asyncio.wait_for(fut, timeout=CALL_S)
    except (asyncio.TimeoutError, WebSocketDisconnect, RuntimeError) as e:
        raise BoxOffline() from e
    finally:
        live.pending.pop(rid, None)
    if not (isinstance(answer, dict) and answer.get("ok") is True):
        raise BoxSaidNo(_text((answer or {}).get("error"), 200) or "The box couldn't do that.")


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


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # noqa: BLE001
        pass


async def _known_box(box_id: uuid.UUID, key: str) -> tuple[str, uuid.UUID | None]:
    """``("ok" | "bad" | "revoked", home_id)``. Its own short session."""
    from app.database import SessionLocal

    from . import codes
    from .models import HomeBox

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
    return {
        "entities": list(live.entities.values()),
        "areas": live.areas,
        "at": datetime.now(timezone.utc).isoformat(),
    }


async def serve(ws: WebSocket) -> None:
    """One box's connection, start to finish."""
    await ws.accept()
    ip = ws.client.host if ws.client else "?"
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
    elif t == "gone":
        if live.entities.pop(_text(msg.get("id"), 200), None) is not None:
            bump(live.home_id)
    elif t == "result":
        fut = live.pending.get(_text(msg.get("id"), 64))
        if fut is not None and not fut.done():
            fut.set_result(msg)
    elif t == "ping":
        await live.send({"t": "pong"})

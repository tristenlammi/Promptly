"""Promptly Home box connector.

Runs on the box in someone's home, next to Home Assistant. It keeps two
lines open:

* to **Home Assistant** on the box (its WebSocket API), to know the home's
  devices and switch them; and
* **out** to the Promptly server (``/api/home/box/ws``), so nothing has to be
  opened on the home's router.

It turns what Home Assistant says into the plain entities the server expects
(see ``backend/app/home/relay.py`` for the protocol) and does what the server
asks. Both lines reconnect by themselves, each on its own.

Configuration, in this order:

* ``PROMPTLY_SETUP``: the setup string from Admin → Home ("pbox1.…"), or the
  ``setup`` option in ``/data/options.json`` (a Home Assistant add-on's
  options).
* Home Assistant: as an add-on (``SUPERVISOR_TOKEN`` is set) it uses the
  Supervisor's proxy and needs nothing else. Otherwise ``HA_URL`` (default
  ``http://homeassistant:8123``) and ``HA_TOKEN``; with no token it sets up a
  fresh Home Assistant by itself (owner account, a long-lived token) and
  keeps the token in ``DATA_DIR`` (default ``/data``).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import random
import secrets
import signal
from pathlib import Path
from typing import Any

import aiohttp

VERSION = "0.1.0"
log = logging.getLogger("promptly-box")

SHOWN = {"light", "switch", "input_boolean", "fan", "sensor", "binary_sensor", "climate", "cover", "lock", "media_player"}
SWITCHABLE = {"light", "switch", "input_boolean", "fan"}
ACTIONS = {"turn_on", "turn_off", "toggle"}
# Home Assistant's own housekeeping, which isn't a device in anyone's home.
NOT_DEVICES = {"sun", "backup", "hassio", "update", "analytics", "cloud", "person", "zone", "shopping_list", "tts", "stt"}
CLIENT_ID = "http://promptly-box.local/"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
# Close codes the server uses to say "don't keep trying like this".
CLOSE_BAD, CLOSE_REVOKED = 4401, 4403


# ------------------------------------------------------------------ configuration


def read_setup() -> dict[str, str]:
    raw = os.environ.get("PROMPTLY_SETUP", "").strip()
    options = DATA_DIR / "options.json"
    if not raw and options.exists():
        raw = str(json.loads(options.read_text()).get("setup") or "").strip()
    if not raw.startswith("pbox1."):
        raise SystemExit("No setup string. Paste the one from Promptly: Admin → Home → Prepare a box.")
    body = raw[len("pbox1.") :]
    try:
        cfg = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        return {"server": str(cfg["s"]).rstrip("/"), "box": str(cfg["b"]), "key": str(cfg["k"])}
    except Exception as e:  # noqa: BLE001
        raise SystemExit("That setup string is damaged. Copy it again from Admin → Home.") from e


def backoff(attempt: int) -> float:
    """1 s, 2 s, 4 s … capped at a minute, with jitter so a street of boxes
    doesn't come back in step after an outage."""
    return min(60.0, 2.0 ** min(attempt, 6)) * (0.7 + random.random() * 0.6)


# ------------------------------------------------------------------ Home Assistant


class HomeAssistant:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self.session = session
        self.supervised = bool(os.environ.get("SUPERVISOR_TOKEN"))
        self.base = "http://supervisor/core" if self.supervised else os.environ.get("HA_URL", "http://homeassistant:8123").rstrip("/")
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.ready = asyncio.Event()
        self._id = 0
        self._waiting: dict[int, asyncio.Future] = {}
        self.entities: dict[str, dict[str, Any]] = {}
        self.areas: list[dict[str, str]] = []
        self._area_of: dict[str, str] = {}  # entity -> area id
        self._skip: set[str] = set()
        self._names: dict[str, str] = {}
        # Told to the server: ("snapshot", None) | ("state", id) | ("gone", id)
        self.changes: asyncio.Queue = asyncio.Queue()
        self._resnap: asyncio.Task | None = None

    # -- signing in

    @property
    def ws_url(self) -> str:
        return ("ws://supervisor/core/websocket") if self.supervised else self.base.replace("http", "ws", 1) + "/api/websocket"

    async def token(self) -> str:
        if self.supervised:
            return os.environ["SUPERVISOR_TOKEN"]
        if os.environ.get("HA_TOKEN"):
            return os.environ["HA_TOKEN"]
        saved = DATA_DIR / "ha_token"
        if saved.exists():
            return saved.read_text().strip()
        token = await self._first_run()
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        saved.write_text(token)
        saved.chmod(0o600)
        return token

    async def _first_run(self) -> str:
        """A Home Assistant nobody has opened: make its owner account and a
        long-lived token, and finish its welcome steps, so no one ever has
        to see its own screens."""
        async with self.session.get(f"{self.base}/api/onboarding") as r:
            steps = await r.json() if r.status == 200 else []
        if not any(s.get("step") == "user" and not s.get("done") for s in steps):
            raise RuntimeError(
                "This Home Assistant is already set up and the box has no token for it. "
                "Give the connector HA_TOKEN (a long-lived access token), or start from a fresh Home Assistant."
            )
        log.info("setting up a fresh Home Assistant")
        password = secrets.token_urlsafe(24)
        owner = {"client_id": CLIENT_ID, "name": "Promptly", "username": "promptly", "password": password, "language": "en"}
        async with self.session.post(f"{self.base}/api/onboarding/users", json=owner) as r:
            r.raise_for_status()
            code = (await r.json())["auth_code"]
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        keep = DATA_DIR / "ha_owner.json"  # for whoever prepared the box, should they ever need HA's own screens
        keep.write_text(json.dumps({"username": "promptly", "password": password}))
        keep.chmod(0o600)
        form = {"grant_type": "authorization_code", "code": code, "client_id": CLIENT_ID}
        async with self.session.post(f"{self.base}/auth/token", data=form) as r:
            r.raise_for_status()
            access = (await r.json())["access_token"]
        auth = {"Authorization": f"Bearer {access}"}
        for step, body in (("core_config", {}), ("analytics", {}), ("integration", {"client_id": CLIENT_ID, "redirect_uri": CLIENT_ID})):
            async with self.session.post(f"{self.base}/api/onboarding/{step}", json=body, headers=auth) as r:
                if r.status >= 400:
                    log.warning("welcome step %s said %s", step, r.status)
        async with self.session.ws_connect(self.ws_url, max_msg_size=0) as ws:
            await ws.receive_json()
            await ws.send_json({"type": "auth", "access_token": access})
            if (await ws.receive_json()).get("type") != "auth_ok":
                raise RuntimeError("Home Assistant refused its own new account")
            await ws.send_json({"id": 1, "type": "auth/long_lived_access_token", "client_name": "Promptly box", "lifespan": 3650})
            answer = await ws.receive_json()
            if not answer.get("success"):
                raise RuntimeError("Home Assistant wouldn't make a token")
            return str(answer["result"])

    # -- talking

    async def ask(self, msg: dict[str, Any], timeout: float = 15.0) -> Any:
        if self.ws is None or self.ws.closed:
            raise RuntimeError("Home Assistant isn't running on the box yet.")
        self._id += 1
        rid = self._id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiting[rid] = fut
        try:
            await self.ws.send_json({"id": rid, **msg})
            answer = await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._waiting.pop(rid, None)
        if not answer.get("success"):
            raise RuntimeError(str((answer.get("error") or {}).get("message") or "Home Assistant said no."))
        return answer.get("result")

    async def run(self) -> None:
        attempt = 0
        while True:
            try:
                token = await self.token()
                async with self.session.ws_connect(self.ws_url, heartbeat=30, max_msg_size=0) as ws:
                    await ws.receive_json()  # auth_required
                    await ws.send_json({"type": "auth", "access_token": token})
                    if (await ws.receive_json()).get("type") != "auth_ok":
                        raise RuntimeError("Home Assistant refused the box's token")
                    self.ws = ws
                    reader = asyncio.create_task(self._read(ws))
                    try:
                        await self._load()
                        for event in ("state_changed", "area_registry_updated", "entity_registry_updated", "device_registry_updated"):
                            await self.ask({"type": "subscribe_events", "event_type": event})
                        self.ready.set()
                        attempt = 0
                        log.info("Home Assistant: %d devices in %d rooms", len(self.entities), len(self.areas))
                        await reader
                    finally:
                        reader.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("Home Assistant line: %s", e)
            self.ws = None
            self.ready.clear()
            for fut in self._waiting.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("Home Assistant went away."))
            attempt += 1
            await asyncio.sleep(backoff(attempt))

    async def _read(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for frame in ws:
            if frame.type != aiohttp.WSMsgType.TEXT:
                continue
            msg = json.loads(frame.data)
            if msg.get("type") == "result":
                fut = self._waiting.get(msg.get("id"))
                if fut is not None and not fut.done():
                    fut.set_result(msg)
            elif msg.get("type") == "event":
                self._event(msg.get("event") or {})

    def _event(self, event: dict[str, Any]) -> None:
        kind = event.get("event_type")
        if kind == "state_changed":
            data = event.get("data") or {}
            eid = str(data.get("entity_id") or "")
            new = data.get("new_state")
            if new is None:
                if self.entities.pop(eid, None) is not None:
                    self.changes.put_nowait(("gone", eid))
                return
            entity = self._entity(new)
            if entity is None:
                return
            if self.entities.get(eid) != entity:
                self.entities[eid] = entity
                self.changes.put_nowait(("state", eid))
        elif kind in ("area_registry_updated", "entity_registry_updated", "device_registry_updated"):
            # Rooms or names changed: read it all again, once things settle.
            if self._resnap is None or self._resnap.done():
                self._resnap = asyncio.create_task(self._reload_soon())

    async def _reload_soon(self) -> None:
        await asyncio.sleep(1.5)
        try:
            await self._load()
        except Exception as e:  # noqa: BLE001
            log.warning("re-reading devices: %s", e)

    async def _load(self) -> None:
        areas = await self.ask({"type": "config/area_registry/list"})
        devices = await self.ask({"type": "config/device_registry/list"})
        registry = await self.ask({"type": "config/entity_registry/list"})
        states = await self.ask({"type": "get_states"})
        self.areas = [{"id": a["area_id"], "name": a["name"]} for a in areas or []]
        device_area = {d["id"]: d.get("area_id") for d in devices or []}
        self._area_of, self._skip, self._names = {}, set(), {}
        for e in registry or []:
            eid = e["entity_id"]
            if e.get("hidden_by") or e.get("disabled_by") or e.get("entity_category") in ("config", "diagnostic") or e.get("platform") in NOT_DEVICES:
                self._skip.add(eid)
            area = e.get("area_id") or device_area.get(e.get("device_id"))
            if area:
                self._area_of[eid] = area
            if e.get("name"):
                self._names[eid] = e["name"]
        entities: dict[str, dict[str, Any]] = {}
        for s in states or []:
            entity = self._entity(s)
            if entity is not None:
                entities[entity["id"]] = entity
        self.entities = entities
        self.changes.put_nowait(("snapshot", None))

    def _entity(self, s: dict[str, Any]) -> dict[str, Any] | None:
        eid = str(s.get("entity_id") or "")
        domain = eid.split(".", 1)[0]
        if domain not in SHOWN or eid in self._skip:
            return None
        attrs = s.get("attributes") or {}
        out: dict[str, Any] = {
            "id": eid,
            "domain": domain,
            "name": self._names.get(eid) or attrs.get("friendly_name") or eid,
            "state": str(s.get("state") or ""),
        }
        if eid in self._area_of:
            out["area"] = self._area_of[eid]
        if attrs.get("unit_of_measurement"):
            out["unit"] = str(attrs["unit_of_measurement"])
        if attrs.get("device_class"):
            out["cls"] = str(attrs["device_class"])
        if domain == "light" and isinstance(attrs.get("brightness"), (int, float)):
            out["bri"] = round(attrs["brightness"] / 255 * 100)
        return out

    async def switch(self, entity_id: str, action: str) -> None:
        domain = entity_id.split(".", 1)[0]
        if domain not in SWITCHABLE or action not in ACTIONS or entity_id not in self.entities:
            raise RuntimeError("That can't be switched.")
        await self.ask({"type": "call_service", "domain": "homeassistant", "service": action, "target": {"entity_id": entity_id}})


# ------------------------------------------------------------------ the Promptly server


class Server:
    def __init__(self, session: aiohttp.ClientSession, setup: dict[str, str], ha: HomeAssistant) -> None:
        self.session, self.setup, self.ha = session, setup, ha
        self.url = setup["server"].replace("http", "ws", 1) + "/api/home/box/ws"

    async def run(self) -> None:
        attempt = 0
        while True:
            code = None
            try:
                async with self.session.ws_connect(self.url, heartbeat=None, max_msg_size=1024 * 1024) as ws:
                    await ws.send_json({"t": "hello", "box": self.setup["box"], "key": self.setup["key"], "v": VERSION})
                    welcome = await ws.receive_json(timeout=20)
                    if welcome.get("t") != "welcome":
                        raise RuntimeError("the server didn't say welcome")
                    attempt = 0
                    log.info("connected to %s (%s)", self.setup["server"], "in a home" if welcome.get("claimed") else "waiting to be claimed")
                    await self._serve(ws)
                    code = ws.close_code
            except asyncio.CancelledError:
                raise
            except aiohttp.WSServerHandshakeError as e:
                log.warning("server refused the line: %s", e.status)
            except Exception as e:  # noqa: BLE001
                log.warning("server line: %s", e)
            if code == CLOSE_REVOKED:
                log.error("This box has been switched off by the server's admin. Trying again in 10 minutes.")
                await asyncio.sleep(600)
            elif code == CLOSE_BAD:
                log.error("The server doesn't know this box's setup string any more. Paste a new one from Admin → Home. Trying again in 5 minutes.")
                await asyncio.sleep(300)
            else:
                attempt += 1
                await asyncio.sleep(backoff(attempt))

    async def _serve(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        sender = asyncio.create_task(self._send(ws))
        try:
            while True:
                frame = await ws.receive(timeout=70)  # the server pings every 25 s
                if frame.type != aiohttp.WSMsgType.TEXT:
                    return
                msg = json.loads(frame.data)
                t = msg.get("t")
                if t == "ping":
                    await ws.send_json({"t": "pong"})
                elif t == "call":
                    asyncio.create_task(self._call(ws, msg))
                elif t in ("claimed", "released"):
                    log.info("the server says this box was %s", "claimed into a home" if t == "claimed" else "released from its home")
        except asyncio.TimeoutError:
            log.warning("the server went quiet")
        finally:
            sender.cancel()

    async def _call(self, ws: aiohttp.ClientWebSocketResponse, msg: dict[str, Any]) -> None:
        answer: dict[str, Any] = {"t": "result", "id": msg.get("id")}
        try:
            await self.ha.switch(str(msg.get("entity") or ""), str(msg.get("action") or ""))
            answer["ok"] = True
        except Exception as e:  # noqa: BLE001
            answer.update(ok=False, error=str(e)[:200])
        try:
            await ws.send_json(answer)
        except Exception:  # noqa: BLE001
            pass

    async def _send(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        """Everything the server should hear: the whole picture first, then
        changes, a few at a time."""
        ha = self.ha
        # Not before Home Assistant has told us everything: a half-read
        # picture would be wrong, and none at all is honest.
        await ha.ready.wait()
        while not ha.changes.empty():  # we're about to say it all anyway
            ha.changes.get_nowait()
        await ws.send_json({"t": "snapshot", "areas": ha.areas, "entities": list(ha.entities.values())})
        while True:
            kind, eid = await ha.changes.get()
            await asyncio.sleep(0.1)  # let a burst arrive
            batch = [(kind, eid)]
            while not ha.changes.empty():
                batch.append(ha.changes.get_nowait())
            if any(k == "snapshot" for k, _ in batch):
                await ws.send_json({"t": "snapshot", "areas": ha.areas, "entities": list(ha.entities.values())})
                continue
            seen: set[str] = set()
            for k, e in reversed(batch):  # the latest word on each one
                if e in seen:
                    continue
                seen.add(e)
                if k == "state" and e in ha.entities:
                    await ws.send_json({"t": "state", "e": ha.entities[e]})
                elif k == "gone":
                    await ws.send_json({"t": "gone", "id": e})


async def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    setup = read_setup()
    log.info("Promptly box %s, server %s", VERSION, setup["server"])
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=15)) as session:
        ha = HomeAssistant(session)
        tasks = [asyncio.create_task(ha.run()), asyncio.create_task(Server(session, setup, ha).run())]
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:  # Windows
                pass
        await stop.wait()
        for t in tasks:
            t.cancel()


if __name__ == "__main__":
    asyncio.run(main())

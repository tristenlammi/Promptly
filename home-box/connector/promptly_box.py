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
import re
import secrets
import signal
from pathlib import Path
from typing import Any

import aiohttp

VERSION = "0.3.0"
log = logging.getLogger("promptly-box")

SHOWN = {"light", "switch", "input_boolean", "fan", "sensor", "binary_sensor", "climate", "cover", "lock", "media_player"}
# What each kind of device can be asked to do -> the Home Assistant service.
SERVICES: dict[tuple[str, str], tuple[str, str]] = {
    ("fan", "speed"): ("fan", "set_percentage"),
    ("cover", "open"): ("cover", "open_cover"),
    ("cover", "close"): ("cover", "close_cover"),
    ("cover", "stop"): ("cover", "stop_cover"),
    ("cover", "position"): ("cover", "set_cover_position"),
    ("climate", "temperature"): ("climate", "set_temperature"),
    ("climate", "mode"): ("climate", "set_hvac_mode"),
    ("media_player", "play"): ("media_player", "media_play"),
    ("media_player", "pause"): ("media_player", "media_pause"),
    ("media_player", "volume"): ("media_player", "volume_set"),
    ("lock", "lock"): ("lock", "lock"),
    ("lock", "unlock"): ("lock", "unlock"),
    ("light", "set"): ("light", "turn_on"),
}
ON_OFF = {"light", "switch", "input_boolean", "fan"}

# "Add by brand": the ones offered first. (id, name, note). Everything else
# Home Assistant can set up is found by searching.
BRANDS: list[tuple[str, str, str]] = [
    ("hue", "Philips Hue", "Needs the Hue Bridge. You'll press the button on it."),
    ("lifx", "LIFX", ""),
    ("tplink", "TP-Link Kasa and Tapo", ""),
    ("shelly", "Shelly", ""),
    ("wiz", "WiZ", ""),
    ("tuya", "Tuya and Smart Life", "Works through Tuya's cloud: you sign in to your Tuya account."),
    ("sonos", "Sonos", ""),
    ("cast", "Google Cast and Chromecast", ""),
    ("esphome", "ESPHome", ""),
    ("matter", "Matter", "Needs a Matter server on the box, which isn't set up yet."),
]
# Set-up steps that aren't a device in anyone's home, or that Promptly does itself.
NOT_BRANDS = {"sun", "backup", "hassio", "cloud", "analytics", "mobile_app", "person", "zone", "homeassistant", "onboarding", "go2rtc", "radio_browser", "shopping_list", "met", "google_translate"}
SECRET_NAMES = ("password", "token", "api_key", "apikey", "secret", "passcode", "access_key", "pin", "psk")
# Home Assistant's own housekeeping, which isn't a device in anyone's home.
NOT_DEVICES = {"sun", "backup", "hassio", "update", "analytics", "cloud", "person", "zone", "shopping_list", "tts", "stt"}
CLIENT_ID = "http://promptly-box.local/"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
# Close codes the server uses to say "don't keep trying like this".
CLOSE_BAD, CLOSE_REVOKED = 4401, 4403


# ------------------------------------------------------------------ configuration


# This server's own box (bundled with Promptly's deployment): always this id,
# and it proves itself with the deployment's HOME_BOX_SECRET, not a setup
# string. The same value as backend/app/home/builtin.py::BOX_ID.
BUILTIN_BOX = "b0000000-0000-4000-8000-00000000b0c5"


def read_setup() -> dict[str, str]:
    if "PROMPTLY_BUILTIN_KEY" in os.environ:
        key = os.environ["PROMPTLY_BUILTIN_KEY"].strip()
        server = os.environ.get("PROMPTLY_SERVER", "").strip().rstrip("/")
        if len(key) < 16 or not server:
            raise SystemExit("HOME_BOX_SECRET isn't set in .env. Run Promptly's update script: it makes one.")
        # Exactly where it's told: inside the deployment, or this machine's own port.
        return {"server": server, "box": BUILTIN_BOX, "key": key}
    raw = os.environ.get("PROMPTLY_SETUP", "").strip()
    options = DATA_DIR / "options.json"
    if not raw and options.exists():
        raw = str(json.loads(options.read_text()).get("setup") or "").strip()
    if not raw.startswith("pbox1."):
        raise SystemExit("No setup string. Paste the one from Promptly: Admin → Home → Prepare a box.")
    body = raw[len("pbox1.") :]
    try:
        cfg = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        setup = {"server": str(cfg["s"]).rstrip("/"), "box": str(cfg["b"]), "key": str(cfg["k"])}
    except Exception as e:  # noqa: BLE001
        raise SystemExit("That setup string is damaged. Copy it again from Admin → Home.") from e
    setup["server"] = server_from_here(os.environ.get("PROMPTLY_SERVER", "").strip() or setup["server"], in_container=Path("/.dockerenv").exists())
    return setup


def server_from_here(server: str, *, in_container: bool) -> str:
    """Promptly on this same computer is "localhost" to the person who
    prepared the box, but not to a container: from in there it's the host."""
    if not in_container:
        return server
    for local in ("//localhost", "//127.0.0.1", "//[::1]"):
        if local in server:
            return server.replace(local, "//" + os.environ.get("PROMPTLY_HOST_NAME", "host.docker.internal"), 1)
    return server


def backoff(attempt: int) -> float:
    """1 s, 2 s, 4 s … capped at a minute, with jitter so a street of boxes
    doesn't come back in step after an outage."""
    return min(60.0, 2.0 ** min(attempt, 6)) * (0.7 + random.random() * 0.6)


# ------------------------------------------------------------------ plain shapes
#
# Pure functions: Home Assistant's answers in, what Promptly shows out.


def extras(domain: str, attrs: dict[str, Any]) -> dict[str, Any]:
    """What a device's controls need beyond on and off."""

    def num(key: str) -> float | None:
        v = attrs.get(key)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    x: dict[str, Any] = {}
    if domain == "light":
        modes = [m for m in attrs.get("supported_color_modes") or [] if isinstance(m, str)]
        if modes:
            x["modes"] = modes
        for ours, theirs in (("k", "color_temp_kelvin"), ("kmin", "min_color_temp_kelvin"), ("kmax", "max_color_temp_kelvin")):
            if num(theirs) is not None:
                x[ours] = num(theirs)
        rgb = attrs.get("rgb_color")
        if isinstance(rgb, (list, tuple)) and len(rgb) == 3:
            x["rgb"] = [int(c) for c in rgb]
    elif domain == "fan" and num("percentage") is not None:
        x["pct"] = num("percentage")
    elif domain == "cover" and num("current_position") is not None:
        x["pos"] = num("current_position")
    elif domain == "climate":
        for ours, theirs in (("target", "temperature"), ("cur", "current_temperature"), ("min", "min_temp"), ("max", "max_temp"), ("step", "target_temp_step")):
            if num(theirs) is not None:
                x[ours] = num(theirs)
        modes = [m for m in attrs.get("hvac_modes") or [] if isinstance(m, str)]
        if modes:
            x["modes"] = modes
    elif domain == "media_player":
        if num("volume_level") is not None:
            x["vol"] = round(num("volume_level") * 100)
        if isinstance(attrs.get("media_title"), str):
            x["title"] = attrs["media_title"]
        if isinstance(attrs.get("is_volume_muted"), bool):
            x["muted"] = attrs["is_volume_muted"]
    return x


def service_for(domain: str, action: str, value: Any) -> tuple[str, str, dict[str, Any]] | None:
    """``(domain, service, data)`` for one of our actions, or None."""
    if action in ("turn_on", "turn_off", "toggle"):
        return ("homeassistant", action, {}) if domain in ON_OFF else None
    call = SERVICES.get((domain, action))
    if call is None:
        return None
    data: dict[str, Any] = {}
    if (domain, action) == ("light", "set") and isinstance(value, dict):
        if "bri" in value:
            data["brightness_pct"] = value["bri"]
        if "k" in value:
            data["color_temp_kelvin"] = value["k"]
        if "rgb" in value:
            data["rgb_color"] = value["rgb"]
    elif action == "speed":
        data["percentage"] = value
    elif action == "position":
        data["position"] = value
    elif action == "temperature":
        data["temperature"] = value
    elif action == "mode":
        data["hvac_mode"] = value
    elif action == "volume":
        data["volume_level"] = round(float(value) / 100, 2)
    return (call[0], call[1], data)


def flat_brands(descriptions: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Home Assistant groups some brands under a maker ("Philips" holds
    "hue"): one flat table, by the id a set-up is started with."""
    out: dict[str, dict[str, Any]] = {}
    for part in ("core", "custom"):
        for group in ("integration", "helper"):
            for domain, info in ((descriptions.get(part) or {}).get(group) or {}).items():
                if not isinstance(info, dict):
                    continue
                inner = info.get("integrations")
                if isinstance(inner, dict):
                    for d, i in inner.items():
                        if isinstance(i, dict):
                            out[d] = {"domain": d, **i, "name": i.get("name") or info.get("name") or d}
                if "config_flow" in info or not isinstance(inner, dict):
                    # Some names live in Home Assistant's translations, not here.
                    out.setdefault(domain, {"domain": domain, **{k: v for k, v in info.items() if k != "integrations"}, "name": info.get("name") or domain.replace("_", " ").capitalize()})
    return out


def brands_for(manifests: dict[str, dict[str, Any]], can_set_up: set[str], q: str) -> list[dict[str, Any]]:
    """The brands offered: the well-known ones first; with a search, every
    brand this Home Assistant can set up whose name matches."""
    out: list[dict[str, Any]] = []
    q = q.strip().lower()

    def one(domain: str, name: str, note: str, featured: bool) -> dict[str, Any]:
        m = manifests.get(domain) or {}
        cloud = str(m.get("iot_class") or "").startswith("cloud")
        return {"id": domain, "name": name, "note": note, "cloud": cloud, "featured": featured}

    featured = {b[0] for b in BRANDS}
    for domain, name, note in BRANDS:
        if domain in can_set_up and (not q or q in name.lower() or q in domain):
            out.append(one(domain, name, note, True))
    if q:
        rest = [
            one(d, str((manifests.get(d) or {}).get("name") or d), "", False)
            for d in can_set_up
            if d not in featured and d not in NOT_BRANDS and (manifests.get(d) or {}).get("integration_type") not in ("system", "entity", "helper")
            and (q in d or q in str((manifests.get(d) or {}).get("name") or "").lower())
        ]
        out += sorted(rest, key=lambda b: b["name"].lower())[:40]
    return out


def _fill(text: str, values: dict[str, Any] | None) -> str:
    """Home Assistant's "{name}" placeholders, without str.format's risks."""
    for k, v in (values or {}).items():
        text = text.replace("{" + str(k) + "}", str(v))
    return text


def _say(text: str, values: dict[str, Any] | None = None) -> str:
    """Home Assistant's wording, made ours: placeholders filled, pictures
    and link targets dropped, and its own name swapped for Promptly's (the
    person never meets Home Assistant)."""
    text = _fill(text or "", values)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = text.replace("Home Assistant", "Promptly")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def found_one(flow: dict[str, Any], manifests: dict[str, dict[str, Any]], words: dict[str, str]) -> dict[str, Any]:
    brand = str(flow.get("handler") or "")
    brand_name = str((manifests.get(brand) or {}).get("name") or brand)
    places = (flow.get("context") or {}).get("title_placeholders") or {}
    title = words.get(f"component.{brand}.config.flow_title")
    name = _say(title, places) if title else str(places.get("name") or places.get("host") or "")
    return {"flow": flow.get("flow_id"), "brand": brand, "brand_name": brand_name, "name": name.strip() or brand_name}


def shape_field(f: dict[str, Any], label: str, hint: str) -> dict[str, Any]:
    """One field of a Home Assistant form, as something to draw."""
    name = str(f.get("name") or "")
    out: dict[str, Any] = {"name": name, "label": label or name.replace("_", " ").capitalize(), "required": bool(f.get("required")), "type": "unsupported"}
    if hint:
        out["hint"] = hint
    default = f.get("default")
    suggested = (f.get("description") or {}).get("suggested_value") if isinstance(f.get("description"), dict) else None
    if suggested is not None:
        default = suggested
    secret = any(part in name.lower() for part in SECRET_NAMES)

    def options(raw: Any) -> list[dict[str, str]]:
        opts = []
        for o in raw or []:
            if isinstance(o, dict):
                opts.append({"value": str(o.get("value")), "label": str(o.get("label") or o.get("value"))})
            elif isinstance(o, (list, tuple)) and len(o) == 2:
                opts.append({"value": str(o[0]), "label": str(o[1])})
            else:
                opts.append({"value": str(o), "label": str(o)})
        return opts

    sel = f.get("selector") if isinstance(f.get("selector"), dict) else None
    kind = str(f.get("type") or "")
    if sel:
        key = next(iter(sel), "")
        conf = sel.get(key) or {}
        if key == "text":
            out["type"] = "password" if conf.get("type") == "password" or secret else "text"
        elif key == "number":
            out["type"] = "number"
            for k in ("min", "max", "step"):
                if isinstance(conf.get(k), (int, float)):
                    out[k] = conf[k]
        elif key == "boolean":
            out["type"] = "bool"
        elif key == "select":
            out["type"] = "multiselect" if conf.get("multiple") else "select"
            out["options"] = options(conf.get("options"))
    elif kind == "string":
        out["type"] = "password" if secret else "text"
    elif kind in ("integer", "float", "positive_int"):
        out["type"] = "number"
        for ours, theirs in (("min", "valueMin"), ("max", "valueMax")):
            if isinstance(f.get(theirs), (int, float)):
                out[ours] = f[theirs]
        if kind != "float":
            out["step"] = 1
    elif kind == "boolean":
        out["type"] = "bool"
    elif kind == "select":
        out["type"] = "select"
        out["options"] = options(f.get("options"))
    elif kind == "multi_select":
        out["type"] = "multiselect"
        raw = f.get("options")
        out["options"] = options(list(raw.items()) if isinstance(raw, dict) else raw)
    if default is not None and out["type"] != "password" and isinstance(default, (str, int, float, bool, list)):
        out["default"] = default
    return out


def shape_flow(r: dict[str, Any], words: dict[str, str], brand_name: str) -> dict[str, Any]:
    """One answer from a Home Assistant set-up flow, as a step to show.

    kind: form (fields to fill, or none: "press the button, then Continue"),
    menu (pick one), wait (it's working: ask again), done, stopped (with the
    reason in words), elsewhere (needs a sign-in on the maker's own site:
    not supported yet).
    """
    brand = str(r.get("handler") or "")
    step = str(r.get("step_id") or "")
    base = f"component.{brand}.config"
    places = r.get("description_placeholders") or {}
    out: dict[str, Any] = {"flow": r.get("flow_id"), "brand": brand, "brand_name": brand_name, "step": step}
    kind = r.get("type")
    if kind == "create_entry":
        entry = r.get("result") if isinstance(r.get("result"), dict) else {}
        out.update(kind="done", title=str(r.get("title") or entry.get("title") or brand_name), entry_id=entry.get("entry_id"))
        return out
    if kind == "abort":
        reason = str(r.get("reason") or "")
        text = words.get(f"{base}.abort.{reason}") or {
            "already_configured": "This is already set up.",
            "already_in_progress": "This is already being set up.",
            "no_devices_found": "Nothing was found on your network.",
            "single_instance_allowed": "This is already set up, and there can only be one.",
            "cannot_connect": "Couldn't reach it.",
        }.get(reason) or "This couldn't be set up."
        out.update(kind="stopped", reason=reason, text=_say(text, places))
        return out
    if kind in ("external", "external_done"):
        out.update(kind="elsewhere", text="This one is finished on the maker's own website, which Promptly can't do for you yet.")
        return out
    if kind in ("show_progress", "show_progress_done"):
        action = str(r.get("progress_action") or "")
        out.update(kind="wait", text=_say(words.get(f"{base}.progress.{action}") or "Working on it…", places))
        return out
    out["title"] = _say(words.get(f"{base}.step.{step}.title") or brand_name, places)
    described = words.get(f"{base}.step.{step}.description")
    if described:
        out["text"] = _say(described, places)
    if kind == "menu":
        raw = r.get("menu_options")
        ids = list(raw.keys()) if isinstance(raw, dict) else list(raw or [])
        out.update(kind="menu", options=[
            {"value": str(i), "label": _say((raw.get(i) if isinstance(raw, dict) else None) or words.get(f"{base}.step.{step}.menu_options.{i}") or str(i).replace("_", " ").capitalize(), places)}
            for i in ids
        ])
        return out
    fields = [
        shape_field(f, words.get(f"{base}.step.{step}.data.{f.get('name')}") or "", words.get(f"{base}.step.{step}.data_description.{f.get('name')}") or "")
        for f in r.get("data_schema") or []
        if isinstance(f, dict) and f.get("type") != "constant"
    ]
    errors = {}
    for field, code in (r.get("errors") or {}).items():
        errors[str(field)] = _say(words.get(f"{base}.error.{code}") or {"cannot_connect": "Couldn't reach it. Check the address and that it's switched on.", "invalid_auth": "That sign-in wasn't accepted.", "unknown": "Something went wrong. Try again."}.get(str(code)) or str(code).replace("_", " ").capitalize(), places)
    out.update(kind="form", fields=fields, errors=errors, last=bool(r.get("last_step")))
    return out


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
        self._words: dict[str, dict[str, str]] = {}
        self._manifests: dict[str, dict[str, Any]] = {}

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
        x = extras(domain, attrs)
        if x:
            out["x"] = x
        return out

    async def do(self, entity_id: str, action: str, value: Any) -> None:
        """Switch or set one device."""
        domain = entity_id.split(".", 1)[0]
        if entity_id not in self.entities:
            raise RuntimeError("That device isn't here any more.")
        call = service_for(domain, action, value)
        if call is None:
            raise RuntimeError("That can't be done.")
        await self.ask({"type": "call_service", "domain": call[0], "service": call[1], "service_data": call[2], "target": {"entity_id": entity_id}})

    # -- Home Assistant's REST API (set-up steps live there)

    async def rest(self, method: str, path: str, body: Any = None) -> Any:
        token = await self.token()
        async with self.session.request(method, f"{self.base}/api{path}", json=body, headers={"Authorization": f"Bearer {token}"}, timeout=aiohttp.ClientTimeout(total=40)) as r:
            text = await r.text()
            if r.status >= 400:
                try:
                    said = json.loads(text).get("message")
                except Exception:  # noqa: BLE001
                    said = None
                raise RuntimeError(str(said or f"Home Assistant said {r.status}.")[:200])
            return json.loads(text) if text else None

    async def words(self, brand: str) -> dict[str, str]:
        """Home Assistant's own wording for a brand's set-up steps."""
        if brand not in self._words:
            try:
                got = await self.ask({"type": "frontend/get_translations", "language": "en", "category": "config", "integration": [brand], "config_flow": True})
                self._words[brand] = dict((got or {}).get("resources") or {})
            except Exception:  # noqa: BLE001
                self._words[brand] = {}
        return self._words[brand]

    async def brand_names(self) -> dict[str, dict[str, Any]]:
        """Every brand Home Assistant knows, by its id: name, whether it
        works through a cloud, what kind of thing it is."""
        if not self._manifests:
            got = await self.ask({"type": "integration/descriptions"}) or {}
            self._manifests = flat_brands(got)
        return self._manifests

    async def op(self, op: str, a: dict[str, Any]) -> Any:
        """One thing the server asked for. Returns plain data."""
        if op == "do":
            await self.do(str(a.get("entity") or ""), str(a.get("action") or ""), a.get("value"))
            return None
        if op == "brands":
            return brands_for(await self.brand_names(), set(await self.rest("GET", "/config/config_entries/flow_handlers") or []), str(a.get("q") or ""))
        if op == "flows.found":
            names = await self.brand_names()
            out = []
            for f in await self.ask({"type": "config_entries/flow/progress"}) or []:
                ctx = f.get("context") or {}
                if ctx.get("source") in (None, "user", "reauth", "reconfigure", "import", "system") or f.get("handler") in NOT_BRANDS:
                    continue
                out.append(found_one(f, names, await self.words(str(f.get("handler")))))
            return out
        if op == "flows.start":
            brand = str(a.get("brand") or "")
            return await self._shaped(await self.rest("POST", "/config/config_entries/flow", {"handler": brand, "show_advanced_options": False}))
        if op == "flows.get":
            return await self._shaped(await self.rest("GET", f"/config/config_entries/flow/{a.get('flow')}"))
        if op == "flows.step":
            given = a.get("input") if isinstance(a.get("input"), dict) else {}
            return await self._shaped(await self.rest("POST", f"/config/config_entries/flow/{a.get('flow')}", given))
        if op == "flows.abort":
            try:
                await self.rest("DELETE", f"/config/config_entries/flow/{a.get('flow')}")
            except RuntimeError:
                pass  # already finished
            return None
        if op == "entries.list":
            names = await self.brand_names()
            return [
                {"id": e["entry_id"], "brand": e["domain"], "brand_name": (names.get(e["domain"]) or {}).get("name") or e["domain"], "title": e.get("title") or "", "state": e.get("state") or ""}
                for e in await self.rest("GET", "/config/config_entries/entry") or []
                if e.get("domain") not in NOT_BRANDS and e.get("source") not in ("system", "ignore")
            ]
        if op == "entries.remove":
            await self.rest("DELETE", f"/config/config_entries/entry/{a.get('entry')}")
            return None
        if op == "areas.create":
            name = str(a.get("name") or "").strip()[:60]
            # "A new room" that's already there is that room, not an error.
            for area in await self.ask({"type": "config/area_registry/list"}) or []:
                if str(area.get("name") or "").strip().lower() == name.lower():
                    return {"id": area["area_id"], "name": area["name"]}
            made = await self.ask({"type": "config/area_registry/create", "name": name})
            return {"id": made["area_id"], "name": made["name"]}
        if op == "areas.rename":
            await self.ask({"type": "config/area_registry/update", "area_id": str(a.get("area")), "name": str(a.get("name") or "")[:60]})
            return None
        if op == "areas.delete":
            await self.ask({"type": "config/area_registry/delete", "area_id": str(a.get("area"))})
            return None
        if op == "device.update":
            await self._device_update(a)
            return None
        raise RuntimeError("This box doesn't know how to do that yet. It may need updating.")

    async def _device_update(self, a: dict[str, Any]) -> None:
        device = a.get("device_id")
        entity = a.get("entity_id")
        if not device and entity:
            for e in await self.ask({"type": "config/entity_registry/list"}) or []:
                if e["entity_id"] == entity:
                    device = e.get("device_id")
                    break
        change: dict[str, Any] = {}
        if "area" in a:
            change["area_id"] = a["area"] or None
        if device:
            if a.get("name"):
                change["name_by_user"] = str(a["name"])[:80]
            await self.ask({"type": "config/device_registry/update", "device_id": device, **change})
        elif entity:
            if a.get("name"):
                change["name"] = str(a["name"])[:80]
            await self.ask({"type": "config/entity_registry/update", "entity_id": entity, **change})
        else:
            raise RuntimeError("Which device?")

    async def _shaped(self, result: dict[str, Any]) -> dict[str, Any]:
        brand = str(result.get("handler") or "")
        names = await self.brand_names()
        out = shape_flow(result, await self.words(brand), (names.get(brand) or {}).get("name") or brand)
        if out["kind"] == "done":
            # What it brought, so the page can ask for a name and a room.
            entry = out.get("entry_id")
            devices = [d for d in await self.ask({"type": "config/device_registry/list"}) or [] if entry and entry in (d.get("config_entries") or [])]
            out["devices"] = [{"device_id": d["id"], "name": d.get("name_by_user") or d.get("name") or "Device", "area": d.get("area_id") or ""} for d in devices[:12]]
        return out


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
                elif t == "req":
                    asyncio.create_task(self._req(ws, msg))
                elif t in ("claimed", "released"):
                    log.info("the server says this box was %s", "claimed into a home" if t == "claimed" else "released from its home")
        except asyncio.TimeoutError:
            log.warning("the server went quiet")
        finally:
            sender.cancel()

    async def _req(self, ws: aiohttp.ClientWebSocketResponse, msg: dict[str, Any]) -> None:
        answer: dict[str, Any] = {"t": "res", "id": msg.get("id")}
        try:
            args = msg.get("args") if isinstance(msg.get("args"), dict) else {}
            answer["data"] = await self.ha.op(str(msg.get("op") or ""), args)
            answer["ok"] = True
        except Exception as e:  # noqa: BLE001
            # Never what was typed: only what went wrong.
            answer.update(ok=False, error=str(e)[:200] or "That didn't work.")
            answer.pop("data", None)
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

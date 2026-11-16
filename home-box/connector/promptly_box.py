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
import hashlib
import json
import logging
import os
import random
import re
import secrets
import signal
import time
from pathlib import Path
from typing import Any

import aiohttp

VERSION = "0.5.0"
log = logging.getLogger("promptly-box")

# Kinds of thing Promptly has controls for. Anything else a brand brings is
# still shown, with its name and what it says (``shown``), unless it's one of
# Home Assistant's own odds and ends (``HIDDEN``).
SHOWN = {"light", "switch", "input_boolean", "fan", "sensor", "binary_sensor", "climate", "cover", "lock", "media_player", "vacuum", "scene", "humidifier", "remote", "valve"}
HIDDEN = {
    "automation", "script", "person", "zone", "sun", "update", "tts", "stt", "conversation", "notify", "device_tracker", "weather",
    "calendar", "todo", "camera", "image", "event", "button", "number", "select", "text", "date", "time", "datetime",
    "input_number", "input_select", "input_text", "input_datetime", "input_button", "timer", "counter", "schedule", "tag",
    "wake_word", "assist_satellite", "ai_task", "geo_location", "image_processing", "homeassistant", "group", "persistent_notification",
}


def shown(domain: str) -> bool:
    return bool(domain) and domain not in HIDDEN
# What each kind of device can be asked to do -> the Home Assistant service.
SERVICES: dict[tuple[str, str], tuple[str, str]] = {
    ("fan", "speed"): ("fan", "set_percentage"),
    ("cover", "open"): ("cover", "open_cover"),
    ("cover", "close"): ("cover", "close_cover"),
    ("cover", "stop"): ("cover", "stop_cover"),
    ("cover", "position"): ("cover", "set_cover_position"),
    ("climate", "temperature"): ("climate", "set_temperature"),
    ("climate", "mode"): ("climate", "set_hvac_mode"),
    ("climate", "fan"): ("climate", "set_fan_mode"),
    ("media_player", "play"): ("media_player", "media_play"),
    ("media_player", "pause"): ("media_player", "media_pause"),
    ("media_player", "next"): ("media_player", "media_next_track"),
    ("media_player", "prev"): ("media_player", "media_previous_track"),
    ("media_player", "stop"): ("media_player", "media_stop"),
    ("media_player", "volume"): ("media_player", "volume_set"),
    ("media_player", "mute"): ("media_player", "volume_mute"),
    ("media_player", "source"): ("media_player", "select_source"),
    ("media_player", "turn_on"): ("media_player", "turn_on"),
    ("media_player", "turn_off"): ("media_player", "turn_off"),
    ("media_player", "join"): ("media_player", "join"),
    ("media_player", "unjoin"): ("media_player", "unjoin"),
    ("fan", "oscillate"): ("fan", "oscillate"),
    ("vacuum", "start"): ("vacuum", "start"),
    ("vacuum", "pause"): ("vacuum", "pause"),
    ("vacuum", "stop"): ("vacuum", "stop"),
    ("vacuum", "dock"): ("vacuum", "return_to_base"),
    ("vacuum", "locate"): ("vacuum", "locate"),
    ("scene", "run"): ("scene", "turn_on"),
    ("valve", "open"): ("valve", "open_valve"),
    ("valve", "close"): ("valve", "close_valve"),
    ("lock", "lock"): ("lock", "lock"),
    ("lock", "unlock"): ("lock", "unlock"),
    ("light", "set"): ("light", "turn_on"),
}
ON_OFF = {"light", "switch", "input_boolean", "fan", "humidifier", "remote"}
# What a device says it can do (Home Assistant's ``supported_features`` bits),
# in our words. The page draws only these; the server refuses the rest.
CAN: dict[str, tuple[tuple[int, str], ...]] = {
    "media_player": ((1, "pause"), (4, "vol"), (8, "mute"), (16, "prev"), (32, "next"), (128, "on"), (256, "off"), (2048, "src"), (4096, "stop"), (16384, "play"), (524288, "group")),
    "climate": ((1, "temp"), (8, "fan"), (128, "off"), (256, "on")),
    "cover": ((1, "open"), (2, "close"), (4, "pos"), (8, "stop")),
    "fan": ((1, "speed"), (2, "osc")),
    "vacuum": ((4, "pause"), (8, "stop"), (16, "dock"), (512, "locate"), (8192, "start")),
}
# With nothing remembered and no word from the device, the mode to start in.
MODE_ORDER = ("auto", "heat_cool", "cool", "heat", "fan_only", "dry")
ART_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
ART_MAX = 300 * 1024

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
    ("wiim", "WiiM", ""),
    ("airtouch5", "AirTouch 5", ""),
]
# Set-up steps that aren't a device in anyone's home, or that Promptly does itself.
NOT_BRANDS = {"sun", "backup", "hassio", "cloud", "analytics", "mobile_app", "person", "zone", "homeassistant", "onboarding", "go2rtc", "radio_browser", "shopping_list", "met", "google_translate"}
SECRET_NAMES = ("password", "token", "api_key", "apikey", "secret", "passcode", "access_key", "pin", "psk")
# Home Assistant's own housekeeping, which isn't a device in anyone's home.
NOT_DEVICES = {"sun", "backup", "hassio", "update", "analytics", "cloud", "person", "zone", "shopping_list", "tts", "stt"}
# How a set-up can start without anyone asking for it: something on the
# network announced itself. An entry that came this way and that nobody
# chose doesn't stay in the home (see ``uninvited``).
NETWORK_SOURCES = {"zeroconf", "ssdp", "dhcp", "homekit", "usb", "bluetooth"}
# What a device mainly is, when it has several parts: the first of these it has.
KIND_ORDER = ("light", "climate", "media_player", "vacuum", "cover", "lock", "fan", "humidifier", "valve", "switch", "input_boolean", "remote", "scene", "binary_sensor", "sensor")

# Our own words for steps people actually meet, over Home Assistant's.
# (brand, step) -> title / text / button. Anything not here uses its wording.
OUR_STEPS: dict[tuple[str, str], dict[str, str]] = {
    ("hue", "link"): {
        "title": "Link your Hue bridge",
        "text": "Press the big round button on top of your Hue bridge, then tap \"I've pressed it\" within 30 seconds.",
        "button": "I've pressed it",
    },
    ("hue", "init"): {"title": "Which Hue bridge?"},
    ("hue", "manual"): {"title": "Your Hue bridge's address"},
    ("wiim", "user"): {"title": "Your WiiM's address", "text": "Type the address your WiiM has on your network. The WiiM Home app shows it: open the speaker's settings, then Speaker Info, and look for IP."},
    ("wiim", "discovery_confirm"): {"title": "Add this WiiM?"},
    ("airtouch5", "user"): {"title": "Your AirTouch 5's address", "text": "Type the address your AirTouch 5 console has on your network. Your router's list of connected devices shows it, usually as AirTouch5."},
}
# (brand or "*", error code) -> what went wrong, in plain words.
OUR_ERRORS: dict[tuple[str, str], str] = {
    ("hue", "register_failed"): "The bridge didn't see its button pressed. Press it, then tap \"I've pressed it\" within 30 seconds.",
    ("hue", "linking"): "The bridge didn't answer. Check it has power and is on your network, then try again.",
    ("*", "cannot_connect"): "Couldn't reach it. Check it's switched on and on the same network, and that the address is right.",
    ("*", "invalid_auth"): "That sign-in wasn't accepted. Check the details and try again.",
    ("*", "invalid_host"): "That doesn't look like an address. It's usually something like 192.168.1.20.",
    ("*", "timeout_connect"): "It took too long to answer. Check it's switched on and close enough to your router, then try again.",
    ("*", "already_configured"): "This is already added to your home.",
    ("*", "unknown"): "Something went wrong. Try again.",
}
ELSEWHERE = "This brand signs you in on its maker's own website, which Promptly doesn't support yet."
# (brand or "*", reason) -> why a set-up stopped.
OUR_STOPS: dict[tuple[str, str], str] = {
    ("hue", "no_bridges"): "No Hue bridge was found on your network. Check it has power and is plugged into your router.",
    ("hue", "discover_timeout"): "Looking for a Hue bridge took too long. Check it has power and is plugged into your router.",
    ("hue", "all_configured"): "Every Hue bridge on your network is already added.",
    ("hue", "not_hue_bridge"): "That address isn't a Hue bridge.",
    ("*", "already_configured"): "This is already added to your home.",
    ("*", "already_in_progress"): "This is already being added. Look under \"Found on your network\".",
    ("*", "no_devices_found"): "Nothing was found on your network. Check it's switched on and on the same network as this home.",
    ("*", "single_instance_allowed"): "This is already added, and there can only be one.",
    ("*", "cannot_connect"): "Couldn't reach it. Check it's switched on and on the same network.",
    ("*", "unknown"): "Something went wrong. Try again.",
    # Brands that sign in on their maker's own website (and need a developer
    # account behind it): said plainly, not left as a dead end.
    ("*", "missing_credentials"): ELSEWHERE,
    ("*", "missing_configuration"): ELSEWHERE,
    ("*", "oauth_error"): ELSEWHERE,
    ("*", "oauth_unauthorized"): ELSEWHERE,
    ("*", "oauth_failed"): ELSEWHERE,
    ("*", "oauth_timeout"): ELSEWHERE,
    ("*", "authorize_url_timeout"): ELSEWHERE,
    ("*", "no_url_available"): ELSEWHERE,
    ("*", "cloud_not_connected"): "This brand needs a paid cloud service, which Promptly doesn't use. It isn't supported yet.",
    ("*", "not_supported"): "This one isn't supported yet.",
}
CANT_PLACE = "This device can't be renamed or put in a room: it doesn't tell Promptly enough about itself."
# Steps that send someone off to make a developer account with the maker
# (Google Nest's "create a Cloud Project"): the same "not supported yet".
DEVELOPER_STEPS = {"create_cloud_project", "cloud_project", "device_project", "pubsub", "pick_implementation"}
# Home Assistant's label -> ours, where its word means nothing to most people.
OUR_LABELS = {"Host": "Address", "IP address": "Address", "IP Address": "Address", "Hostname or IP address": "Address"}
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
    elif domain == "fan":
        if num("percentage") is not None:
            x["pct"] = num("percentage")
        if isinstance(attrs.get("oscillating"), bool):
            x["osc"] = attrs["oscillating"]
    elif domain == "cover" and num("current_position") is not None:
        x["pos"] = num("current_position")
    elif domain == "climate":
        for ours, theirs in (("target", "temperature"), ("cur", "current_temperature"), ("min", "min_temp"), ("max", "max_temp"), ("step", "target_temp_step"), ("hum", "current_humidity")):
            if num(theirs) is not None:
                x[ours] = num(theirs)
        modes = [m for m in attrs.get("hvac_modes") or [] if isinstance(m, str)]
        if modes:
            x["modes"] = modes
        fans = [m for m in attrs.get("fan_modes") or [] if isinstance(m, str)]
        if fans:
            x["fans"] = fans[:16]
        if isinstance(attrs.get("fan_mode"), str):
            x["fan"] = attrs["fan_mode"]
        # What it's doing right now (heating, cooling, idle), which isn't its mode.
        if isinstance(attrs.get("hvac_action"), str):
            x["act"] = attrs["hvac_action"]
    elif domain == "media_player":
        if num("volume_level") is not None:
            x["vol"] = round(num("volume_level") * 100)
        for ours, theirs in (("title", "media_title"), ("artist", "media_artist"), ("src", "source")):
            if isinstance(attrs.get(theirs), str) and attrs[theirs]:
                x[ours] = attrs[theirs]
        if isinstance(attrs.get("is_volume_muted"), bool):
            x["muted"] = attrs["is_volume_muted"]
        srcs = [m for m in attrs.get("source_list") or [] if isinstance(m, str)]
        if srcs:
            x["srcs"] = srcs[:40]
        members = [m for m in attrs.get("group_members") or [] if isinstance(m, str)]
        if members:
            x["members"] = members[:32]
        if isinstance(attrs.get("entity_picture"), str) and attrs["entity_picture"]:
            # Changes when the picture does; the picture itself is fetched on its own (op "art").
            x["art"] = hashlib.sha1(attrs["entity_picture"].encode()).hexdigest()[:12]
    elif domain == "vacuum" and num("battery_level") is not None:
        x["bat"] = num("battery_level")
    can = can_of(domain, attrs)
    if can is not None:
        x["can"] = can
    return x


def can_of(domain: str, attrs: dict[str, Any]) -> list[str] | None:
    """What this device says it can do, or None for a kind with nothing to say."""
    table = CAN.get(domain)
    if table is None:
        return None
    bits = attrs.get("supported_features")
    bits = bits if isinstance(bits, int) and not isinstance(bits, bool) else 0
    return [name for bit, name in table if bits & bit]


def zones_of(climates: dict[str, tuple[str, list[str]]]) -> dict[str, dict[str, Any]]:
    """Ducted air con comes as one unit and a "thermostat" per zone (a zone
    only opens and closes, so its modes are just off and fan). Which is
    which, so the page shows zones under their unit and not as six air
    conditioners. ``climates`` is entity -> (set-up it came with, its modes);
    out is entity -> {"sys": the unit it belongs to, "zone": True}, and the
    unit itself -> {"sys": itself}."""
    by_entry: dict[str, list[str]] = {}
    for eid, (entry, _modes) in climates.items():
        if entry:
            by_entry.setdefault(entry, []).append(eid)
    out: dict[str, dict[str, Any]] = {}
    for ids in by_entry.values():
        if len(ids) < 2:
            continue
        ons = {eid: {m for m in climates[eid][1] if m != "off"} for eid in ids}
        units = sorted(eid for eid in ids if not ons[eid] <= {"fan_only"})
        zones = sorted(eid for eid in ids if ons[eid] <= {"fan_only"})
        if len(units) != 1 or not zones:
            continue  # two units, or nothing that's plainly a zone: leave them as they are
        out[units[0]] = {"sys": units[0]}
        for z in zones:
            out[z] = {"sys": units[0], "zone": True}
    return out


def climate_on(modes: list[str], last: str | None) -> tuple[str, str, dict[str, Any]]:
    """Turning air con on is "the way it was", not "the first mode it has":
    Home Assistant's own turn-on, where a brand hasn't written its own
    (AirTouch 5 hasn't), picks heat before cool. So: the mode it was last on
    in; with nothing remembered, the one that lets the unit decide."""
    ons = [m for m in modes if m != "off"]
    if last in ons:
        return ("climate", "set_hvac_mode", {"hvac_mode": last})
    for m in MODE_ORDER:
        if m in ons:
            return ("climate", "set_hvac_mode", {"hvac_mode": m})
    if ons:
        return ("climate", "set_hvac_mode", {"hvac_mode": ons[0]})
    return ("climate", "turn_on", {})


def our_words(table: dict[tuple[str, str], str], brand: str, code: str) -> str | None:
    return table.get((brand, code)) or table.get(("*", code))


def brand_group(domain: str, attrs: dict[str, Any]) -> dict[str, Any] | None:
    """A brand's own "room" or "zone" of lights (Hue's grouped lights), or a
    light group made in Home Assistant: one switch for several lights. It
    isn't a device anyone has, so it gets no tile; Promptly's own rooms use
    it under the hood to turn a room's lights on and off in one go."""
    if domain != "light":
        return None
    members = attrs.get("entity_id")
    if attrs.get("is_hue_group") is True or isinstance(members, (list, tuple)):
        return {"members": sorted(str(m) for m in members or [] if isinstance(m, str)), "kind": str(attrs.get("hue_type") or "group")}
    return None


def speaker_group(attrs: dict[str, Any], model: str | None) -> bool:
    """Several speakers that play as one ("Downstairs Speakers"): kept, since
    it's something to play to, and marked as a group."""
    return isinstance(attrs.get("entity_id"), (list, tuple)) or (model or "").strip().lower() == "google cast group"


def lights_target(lights: list[str], groups: dict[str, dict[str, Any]]) -> list[str]:
    """What to switch for "all the lights in this room": the brand's own
    group when it is exactly these lights (one command, they change
    together), otherwise each light."""
    want = set(lights)
    for gid, g in sorted(groups.items()):
        if want and set(g.get("members") or []) == want:
            return [gid]
    return sorted(lights)


def devices_of(entry_id: str, devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [d for d in devices if d.get("config_entry_id") == entry_id or entry_id in (d.get("config_entries") or [])]


def _shown_entity(e: dict[str, Any]) -> bool:
    return (
        shown(str(e.get("entity_id") or "").split(".", 1)[0])
        and not e.get("hidden_by")
        and not e.get("disabled_by")
        and e.get("entity_category") not in ("config", "diagnostic")
        and e.get("platform") not in NOT_DEVICES
    )


def brought(entry_id: str, devices: list[dict[str, Any]], registry: list[dict[str, Any]], groups: set[str], areas: dict[str, str]) -> dict[str, Any]:
    """What a finished set-up brought into the home, for a one-line summary
    ("1 light in Lounge Room") instead of a form per device.

    Left out: bridges and hubs (nothing of theirs to show), the brand's own
    rooms and zones (``groups``; Home Assistant lists Hue's as devices), and
    anything with nothing to show. ``areas`` is id -> name."""
    by_device: dict[str, list[str]] = {}
    for e in registry:
        # (A scene isn't a device: Hue hangs its scenes on its own "rooms".)
        if e.get("device_id") and e.get("entity_id") not in groups and _shown_entity(e) and not str(e["entity_id"]).startswith("scene."):
            by_device.setdefault(e["device_id"], []).append(str(e["entity_id"]).split(".", 1)[0])
    things: list[dict[str, Any]] = []
    for d in devices_of(entry_id, devices):
        kinds = by_device.get(d["id"]) or []
        if not kinds:
            continue
        kind = next((k for k in KIND_ORDER if k in kinds), kinds[0])
        things.append({"device_id": d["id"], "name": d.get("name_by_user") or d.get("name") or "Device", "kind": kind, "area": d.get("area_id") or ""})
    counts: dict[tuple[str, str], int] = {}
    for t in things:
        key = (t["kind"], areas.get(t["area"], "") if t["area"] else "")
        counts[key] = counts.get(key, 0) + 1
    summary = [{"n": n, "kind": kind, "room": room} for (kind, room), n in sorted(counts.items(), key=lambda kv: (kv[0][1] == "", kv[0][1].lower(), kv[0][0]))]
    return {"things": things[:60], "summary": summary[:20], "loose": sum(1 for t in things if not t["area"])}


def uninvited(entries: list[dict[str, Any]], chosen: set[str]) -> list[dict[str, Any]]:
    """Set-ups that are in the home though nobody chose them: they came from
    something announcing itself on the network, and no one tapped Add.
    Nothing joins a home by itself, so these go back to "Found on your
    network"."""
    return [
        e for e in entries
        if e.get("source") in NETWORK_SOURCES and e.get("domain") not in NOT_BRANDS and e.get("entry_id") not in chosen
    ]


def first_chosen(entries: list[dict[str, Any]], devices: list[dict[str, Any]], onboarded_at: float | None) -> set[str]:
    """The first time this rule runs on a home that already exists: which
    set-ups count as chosen. Everything, except what appeared on its own.

    Home Assistant only sets a found device up without asking while it is
    still being set up itself, so "on its own" is: came from the network,
    before (or as) the box finished its own first start, and nobody has since
    named any of it or put it in a room. Without knowing when that was
    (``onboarded_at`` is None), everything is kept."""
    chosen: set[str] = set()
    for e in entries:
        touched = any(d.get("name_by_user") or d.get("area_id") for d in devices_of(str(e.get("entry_id")), devices))
        early = onboarded_at is not None and float(e.get("created_at") or 0) <= onboarded_at + 30
        if not (e.get("source") in NETWORK_SOURCES and early and not touched):
            chosen.add(str(e.get("entry_id")))
    return chosen


def service_for(domain: str, action: str, value: Any, x: dict[str, Any] | None = None, last: str | None = None) -> tuple[str, str, dict[str, Any]] | None:
    """``(domain, service, data)`` for one of our actions, or None. ``x`` is
    the device's extras and ``last`` the mode an air con was last on in."""
    if domain == "climate" and action in ("turn_on", "turn_off"):
        modes = list((x or {}).get("modes") or [])
        if action == "turn_off":
            return ("climate", "set_hvac_mode", {"hvac_mode": "off"}) if "off" in modes else ("climate", "turn_off", {})
        return climate_on(modes, last)
    if action in ("turn_on", "turn_off", "toggle") and (domain, action) not in SERVICES:
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
    elif action == "mute":
        data["is_volume_muted"] = bool(value)
    elif action == "source":
        data["source"] = value
    elif action == "fan":
        data["fan_mode"] = value
    elif action == "oscillate":
        data["oscillating"] = bool(value)
    elif action == "join":
        data["group_members"] = [str(m) for m in value or []]
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
    label = OUR_LABELS.get(label, label) or ("Address" if name == "host" else name.replace("_", " ").capitalize())
    out: dict[str, Any] = {"name": name, "label": label, "required": bool(f.get("required")), "type": "unsupported"}
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
        text = our_words(OUR_STOPS, brand, reason) or words.get(f"{base}.abort.{reason}") or "This couldn't be added."
        out.update(kind="stopped", reason=reason, text=_say(text, places))
        return out
    if kind in ("external", "external_done") or (kind in ("form", "menu") and step in DEVELOPER_STEPS):
        out.update(kind="elsewhere", text=ELSEWHERE)
        return out
    if kind in ("show_progress", "show_progress_done"):
        action = str(r.get("progress_action") or "")
        out.update(kind="wait", text=_say(words.get(f"{base}.progress.{action}") or "Working on it…", places))
        return out
    ours = OUR_STEPS.get((brand, step)) or {}
    out["title"] = _say(ours.get("title") or words.get(f"{base}.step.{step}.title") or brand_name, places)
    described = ours.get("text") or words.get(f"{base}.step.{step}.description")
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
        errors[str(field)] = _say(our_words(OUR_ERRORS, brand, str(code)) or words.get(f"{base}.error.{code}") or str(code).replace("_", " ").capitalize(), places)
    out.update(kind="form", fields=fields, errors=errors, last=bool(r.get("last_step")))
    if ours.get("button"):
        out["button"] = ours["button"]
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
        # A brand's own rooms and zones of lights: entity -> {members, kind}.
        self.groups: dict[str, dict[str, Any]] = {}
        self._device_of: dict[str, str] = {}  # entity -> device
        self._model_of: dict[str, str] = {}  # device -> model
        self._entry_of: dict[str, str] = {}  # entity -> the set-up it came with
        self._zones: dict[str, dict[str, Any]] = {}  # air-con units and their zones
        # The mode each air con was last on in, so "on" means "as it was" (last_modes.json).
        self._last_mode: dict[str, str] | None = None
        # Just made its own account on a fresh Home Assistant.
        self._fresh = False
        # Set-ups someone chose, and what to tell them once (policy.json).
        self._policy: dict[str, Any] | None = None
        self._steps: list[list[float]] = []  # [started, ended or 0] of each answer sent to a set-up
        self._enforcing = False

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
        self._fresh = True
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
                        if await self._restart_to_listen():
                            try:  # it goes away now; the loop comes back for it
                                await asyncio.wait_for(asyncio.shield(reader), timeout=90)
                                continue
                            except asyncio.TimeoutError:
                                log.warning("Home Assistant didn't restart; carrying on without it looking for devices")
                        await self._enforce()
                        await self._no_rooms_of_its_own()
                        await self._load()
                        for event in ("state_changed", "area_registry_updated", "entity_registry_updated", "device_registry_updated"):
                            await self.ask({"type": "subscribe_events", "event_type": event})
                        await self._check_listening()
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
            if self.ready.is_set():
                # The server should know its picture is stale until we're back.
                self.changes.put_nowait(("down", None))
            self.ready.clear()
            for fut in self._waiting.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("Home Assistant went away."))
            attempt += 1
            await asyncio.sleep(backoff(attempt))

    async def _restart_to_listen(self) -> bool:
        """Bundled with Promptly, a fresh Home Assistant starts without
        looking for devices (``home-box/ha_config.py``): until it has its
        account, it would set up whatever it found without asking. Now that
        it has one, restart it once so it starts looking."""
        # Only a Home Assistant this box set up itself, and not over and over.
        if self.supervised or os.environ.get("HA_TOKEN") or not (DATA_DIR / "ha_token").exists():
            return False
        tries = DATA_DIR / "listen_restarts"
        try:
            n = int(tries.read_text().strip() or 0) if tries.exists() else 0
        except (OSError, ValueError):
            n = 0
        if n >= 3:
            return False
        try:
            config = await self.ask({"type": "get_config"})
            if "zeroconf" in ((config or {}).get("components") or []):
                return False
            try:
                tries.write_text(str(n + 1))
            except OSError:
                return False
            log.info("restarting Home Assistant once, so it starts looking for devices")
            await self.ask({"type": "call_service", "domain": "homeassistant", "service": "restart", "service_data": {}}, timeout=4)
        except Exception as e:  # noqa: BLE001 - it may go before it answers
            log.info("restart asked (%s)", e)
        return True

    async def _no_rooms_of_its_own(self) -> None:
        """A fresh Home Assistant comes with three rooms of its own (Living
        Room, Kitchen, Bedroom). Rooms are made in Promptly, or come with a
        brand's devices: a new home starts with none."""
        if not self._fresh:
            return
        self._fresh = False
        try:
            for a in await self.ask({"type": "config/area_registry/list"}) or []:
                await self.ask({"type": "config/area_registry/delete", "area_id": a["area_id"]})
        except Exception as e:  # noqa: BLE001
            log.warning("clearing the starter rooms: %s", e)

    # -- nothing joins a home by itself

    def _policy_path(self) -> Path:
        return DATA_DIR / "policy.json"

    def _save_policy(self) -> None:
        if self._policy is None:
            return
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp = self._policy_path().with_suffix(".tmp")
            tmp.write_text(json.dumps({**self._policy, "chosen": sorted(self._policy["chosen"])}))
            tmp.replace(self._policy_path())
        except OSError as e:
            log.warning("couldn't save what was chosen: %s", e)

    def note(self) -> dict[str, Any] | None:
        return (self._policy or {}).get("note") or None

    def _chose(self, entry_id: Any) -> None:
        if entry_id and self._policy is not None:
            self._policy["chosen"].add(str(entry_id))
            self._save_policy()

    async def _enforce(self) -> None:
        """Take out set-ups nobody chose (``uninvited``), so what was found
        goes back to "Found on your network", and note it to say once."""
        if self._enforcing or any(not ended for _, ended in self._steps):
            return
        if self.supervised or os.environ.get("HA_TOKEN"):
            return  # somebody's own Home Assistant: what they add there is theirs
        self._enforcing = True
        try:
            entries = await self.rest("GET", "/config/config_entries/entry") or []
            devices = await self.ask({"type": "config/device_registry/list"}) or []
            if self._policy is None:
                path = self._policy_path()
                if path.exists():
                    try:
                        saved = json.loads(path.read_text())
                        self._policy = {"chosen": set(saved.get("chosen") or []), "note": saved.get("note")}
                    except (OSError, ValueError):
                        self._policy = None
                if self._policy is None:
                    token = DATA_DIR / "ha_token"
                    self._policy = {"chosen": first_chosen(entries, devices, token.stat().st_mtime if token.exists() else None), "note": None}
                    self._save_policy()
            chosen: set[str] = self._policy["chosen"]
            # Chosen a moment ago, in a step whose answer we never saw (it timed out).
            for e in uninvited(entries, chosen):
                made = float(e.get("created_at") or 0)
                if any(start - 2 <= made <= (end or time.time()) + 90 for start, end in self._steps):
                    chosen.add(str(e["entry_id"]))
            out = uninvited(entries, chosen)
            if not out:
                return
            registry = await self.ask({"type": "config/entity_registry/list"}) or []
            names = await self.brand_names()
            n, kinds = 0, set()
            for e in out:
                mine = {d["id"] for d in devices_of(str(e["entry_id"]), devices)}
                for r in registry:
                    domain = str(r.get("entity_id") or "").split(".", 1)[0]
                    if r.get("device_id") in mine and _shown_entity(r) and domain not in ("sensor", "binary_sensor"):
                        n += 1
                        kinds.add(domain)
                try:
                    await self.rest("DELETE", f"/config/config_entries/entry/{e['entry_id']}")
                    log.info("%s appeared on its own: back to \"Found on your network\"", e.get("domain"))
                except RuntimeError as err:
                    log.warning("couldn't take out %s: %s", e.get("domain"), err)
            old = self._policy.get("note") or {}
            brands = sorted({*(old.get("brands") or []), *(str((names.get(e["domain"]) or {}).get("name") or e["domain"]) for e in out)})
            self._policy["note"] = {
                "n": int(old.get("n") or 0) + n,
                "what": "speakers" if kinds <= {"media_player"} and (old.get("what") in (None, "speakers")) else "devices",
                "brands": brands[:6],
            }
            self._save_policy()
        except Exception as e:  # noqa: BLE001 - never at the cost of the line
            log.warning("checking what was chosen: %s", e)
        finally:
            self._enforcing = False

    async def _check_listening(self) -> None:
        """Home Assistant falls back to its built-in web settings (every
        address, port 8123) if it can't use the ones it was given, e.g. the
        port is taken. Bundled with Promptly on a Linux host that would put
        its own screens on the home network: say so, loudly."""
        if self.supervised:
            return
        try:
            got = await self.ask({"type": "http/config"})
        except Exception:  # noqa: BLE001 - older Home Assistant: nothing to check
            return
        if str((got or {}).get("active_config_type") or "stable") != "stable":
            log.error(
                "Home Assistant couldn't use the web settings Promptly gave it and fell back to its own "
                "(it may be listening on every address). Is its port taken? Set HOME_HA_PORT in .env to a free one."
            )

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
                self.groups.pop(eid, None)
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
            await self._enforce()
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
        self._model_of = {d["id"]: str(d.get("model") or "") for d in devices or []}
        self._device_of, self.groups, self._entry_of = {}, {}, {}
        for e in registry or []:
            eid = e["entity_id"]
            if e.get("device_id"):
                self._device_of[eid] = e["device_id"]
            if e.get("config_entry_id"):
                self._entry_of[eid] = e["config_entry_id"]
            if e.get("hidden_by") or e.get("disabled_by") or e.get("entity_category") in ("config", "diagnostic") or e.get("platform") in NOT_DEVICES:
                self._skip.add(eid)
            area = e.get("area_id") or device_area.get(e.get("device_id"))
            if area:
                self._area_of[eid] = area
            if e.get("name"):
                self._names[eid] = e["name"]
        self._zones = zones_of({
            str(s.get("entity_id")): (self._entry_of.get(str(s.get("entity_id")), ""), [m for m in (s.get("attributes") or {}).get("hvac_modes") or [] if isinstance(m, str)])
            for s in states or []
            if str(s.get("entity_id") or "").startswith("climate.") and str(s.get("entity_id")) not in self._skip
        })
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
        if not shown(domain) or eid in self._skip:
            return None
        attrs = s.get("attributes") or {}
        group = brand_group(domain, attrs)
        if group is not None:
            # Not a device: kept to switch a room's lights together.
            self.groups[eid] = {**group, "area": self._area_of.get(eid, "")}
            return None
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
        device = self._device_of.get(eid)
        if device:
            out["dev"] = device
        if domain == "media_player" and speaker_group(attrs, self._model_of.get(device or "")):
            out["grp"] = True
        x = extras(domain, attrs)
        if domain == "climate":
            x.update(self._zones.get(eid) or {})
            state = out["state"]
            if state not in ("off", "unavailable", "unknown", ""):
                self._remember_mode(eid, state)
            last = self._modes().get(eid)
            if last:
                x["last"] = last
        if x:
            out["x"] = x
        return out

    def _modes(self) -> dict[str, str]:
        if self._last_mode is None:
            try:
                saved = json.loads((DATA_DIR / "last_modes.json").read_text())
                self._last_mode = {str(k): str(v) for k, v in saved.items()} if isinstance(saved, dict) else {}
            except (OSError, ValueError):
                self._last_mode = {}
        return self._last_mode

    def _remember_mode(self, eid: str, mode: str) -> None:
        modes = self._modes()
        if modes.get(eid) == mode:
            return
        modes[eid] = mode
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp = DATA_DIR / "last_modes.tmp"
            tmp.write_text(json.dumps(modes))
            tmp.replace(DATA_DIR / "last_modes.json")
        except OSError as e:
            log.warning("couldn't keep an air con's last mode: %s", e)

    async def do(self, entity_id: str, action: str, value: Any) -> None:
        """Switch or set one device."""
        domain = entity_id.split(".", 1)[0]
        entity = self.entities.get(entity_id)
        if entity is None:
            raise RuntimeError("That device isn't here any more.")
        if (domain, action) == ("media_player", "join"):
            # Only speakers in this home that can be grouped.
            value = [m for m in value or [] if m != entity_id and "group" in ((self.entities.get(m) or {}).get("x") or {}).get("can", [])]
            if not value:
                raise RuntimeError("Pick a speaker to group it with.")
        call = service_for(domain, action, value, entity.get("x"), self._modes().get(entity_id))
        if call is None:
            raise RuntimeError("That can't be done.")
        await self.ask({"type": "call_service", "domain": call[0], "service": call[1], "service_data": call[2], "target": {"entity_id": entity_id}})

    async def art(self, entity_id: str) -> dict[str, str]:
        """The picture of what a speaker is playing, through Home Assistant's
        own proxy (never fetched from wherever the speaker says it is)."""
        if entity_id not in self.entities or not entity_id.startswith("media_player."):
            raise RuntimeError("That device isn't here any more.")
        token = await self.token()
        async with self.session.get(f"{self.base}/api/media_player_proxy/{entity_id}", headers={"Authorization": f"Bearer {token}"}, timeout=aiohttp.ClientTimeout(total=10)) as r:
            kind = (r.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if r.status != 200 or kind not in ART_TYPES:
                raise RuntimeError("No picture.")
            body = await r.content.read(ART_MAX + 1)
            if len(body) > ART_MAX:
                raise RuntimeError("No picture.")
        return {"type": kind, "b64": base64.b64encode(body).decode()}

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
        if op == "art":
            return await self.art(str(a.get("entity") or ""))
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
            # Someone is answering a set-up: what it makes is theirs (see _enforce).
            mark = [time.time(), 0.0]
            self._steps = [w for w in self._steps[-20:] if not w[1] or time.time() - w[1] < 600] + [mark]
            try:
                return await self._shaped(await self.rest("POST", f"/config/config_entries/flow/{a.get('flow')}", given))
            finally:
                mark[1] = time.time()
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
        if op == "areas.merge":
            await self._merge_rooms(str(a.get("area") or ""), str(a.get("into") or ""))
            return None
        if op == "areas.order":
            have = [x["area_id"] for x in await self.ask({"type": "config/area_registry/list"}) or []]
            want = [str(i) for i in a.get("order") or [] if str(i) in have]
            await self.ask({"type": "config/area_registry/reorder", "area_ids": want + [i for i in have if i not in want]})
            return None
        if op == "devices.place":
            area = str(a.get("area") or "")
            done: set[str] = set()
            moved = failed = 0
            for eid in [str(i) for i in a.get("entities") or []][:200]:
                device = self._device_of.get(eid)
                if device in done:
                    continue
                # One that can't be moved doesn't stop the rest.
                try:
                    await self._device_update({"entity_id": eid, "device_id": device, "area": area})
                    moved += 1
                except RuntimeError:
                    failed += 1
                if device:
                    done.add(device)
            if failed and not moved:
                raise RuntimeError(CANT_PLACE)
            return None
        if op == "room.lights":
            area, action = str(a.get("area") or ""), str(a.get("action") or "")
            lights = [eid for eid, e in self.entities.items() if e["domain"] == "light" and e.get("area") == area]
            if not lights or action not in ("turn_on", "turn_off"):
                raise RuntimeError("There are no lights in that room.")
            await self.ask({"type": "call_service", "domain": "light", "service": action, "service_data": {}, "target": {"entity_id": lights_target(lights, self.groups)}})
            return None
        if op == "note.clear":
            if self._policy is not None and self._policy.get("note"):
                self._policy["note"] = None
                self._save_policy()
                self.changes.put_nowait(("snapshot", None))
            return None
        if op == "device.update":
            await self._device_update(a)
            return None
        raise RuntimeError("This box doesn't know how to do that yet. It may need updating.")

    async def _merge_rooms(self, gone: str, into: str) -> None:
        """Everything in one room moves to another, and the first goes."""
        have = {x["area_id"] for x in await self.ask({"type": "config/area_registry/list"}) or []}
        if gone == into or gone not in have or into not in have:
            raise RuntimeError("Pick two different rooms.")
        for d in await self.ask({"type": "config/device_registry/list"}) or []:
            if d.get("area_id") == gone:
                await self.ask({"type": "config/device_registry/update", "device_id": d["id"], "area_id": into})
        for e in await self.ask({"type": "config/entity_registry/list"}) or []:
            if e.get("area_id") == gone:
                await self.ask({"type": "config/entity_registry/update", "entity_id": e["entity_id"], "area_id": into})
        await self.ask({"type": "config/area_registry/delete", "area_id": gone})

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
            try:
                await self.ask({"type": "config/entity_registry/update", "entity_id": entity, **change})
            except RuntimeError as e:
                # A few devices give Home Assistant nothing to remember them by.
                raise RuntimeError(CANT_PLACE if "not found" in str(e).lower() else str(e)) from e
        else:
            raise RuntimeError("Which device?")

    async def _shaped(self, result: dict[str, Any]) -> dict[str, Any]:
        brand = str(result.get("handler") or "")
        names = await self.brand_names()
        out = shape_flow(result, await self.words(brand), (names.get(brand) or {}).get("name") or brand)
        if out["kind"] == "elsewhere" and out.get("flow"):
            # It can't be finished here: don't leave it half-started on the box.
            try:
                await self.rest("DELETE", f"/config/config_entries/flow/{out['flow']}")
            except RuntimeError:
                pass
        if out["kind"] == "done":
            entry = str(out.get("entry_id") or "")
            self._chose(entry)
            # What it brought, already in the rooms the brand knows them by
            # (Home Assistant makes a room for a new name): said in a line.
            await asyncio.sleep(1.0)  # its parts are still arriving
            try:
                devices = await self.ask({"type": "config/device_registry/list"}) or []
                registry = await self.ask({"type": "config/entity_registry/list"}) or []
                areas = {x["area_id"]: x["name"] for x in await self.ask({"type": "config/area_registry/list"}) or []}
                groups = {str(st.get("entity_id")) for st in await self.ask({"type": "get_states"}) or [] if brand_group(str(st.get("entity_id") or "").split(".", 1)[0], st.get("attributes") or {})}
                out.update(brought(entry, devices, registry, groups, areas))
            except Exception as e:  # noqa: BLE001 - it's added; the page just says less
                log.warning("couldn't list what was added: %s", e)
                out.update(things=[], summary=[], loose=0)
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
                    waiting = "waiting for Promptly Home to be turned on" if self.setup["box"] == BUILTIN_BOX else "waiting to be claimed"
                    log.info("connected to %s (%s)", self.setup["server"], "in a home" if welcome.get("claimed") else waiting)
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

    def _snapshot(self) -> dict[str, Any]:
        ha = self.ha
        msg: dict[str, Any] = {"t": "snapshot", "areas": ha.areas, "entities": list(ha.entities.values())}
        if ha.note():
            msg["note"] = ha.note()
        return msg

    async def _send(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        """Everything the server should hear: the whole picture first, then
        changes, a few at a time."""
        ha = self.ha
        # Not before Home Assistant has told us everything: a half-read
        # picture would be wrong, and none at all is honest.
        await ha.ready.wait()
        while not ha.changes.empty():  # we're about to say it all anyway
            ha.changes.get_nowait()
        await ws.send_json(self._snapshot())
        while True:
            kind, eid = await ha.changes.get()
            await asyncio.sleep(0.1)  # let a burst arrive
            batch = [(kind, eid)]
            while not ha.changes.empty():
                batch.append(ha.changes.get_nowait())
            if batch[-1][0] == "down" or (not ha.ready.is_set() and any(k == "down" for k, _ in batch)):
                # Home Assistant went away (restarting, updating): say so, and
                # wait for it before saying anything else.
                await ws.send_json({"t": "down"})
                await ha.ready.wait()
                while not ha.changes.empty():
                    ha.changes.get_nowait()
                await ws.send_json(self._snapshot())
                continue
            if any(k == "snapshot" for k, _ in batch):
                await ws.send_json(self._snapshot())
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

"""Turning a connector's live state into a list of devices you can pick.

Home Assistant exposes *intents* — ``HassTurnOff`` — not one tool per
device, so the editor could only ever offer "turn something off" and ask
you to type which thing. But HA also exposes ``GetLiveContext``, which
returns every entity exposed to Assist. That's the device list, one tool
call away, with nothing extra to enable.

Two things keep this from becoming a pile of Home-Assistant trivia:

* **The parser is tolerant and self-diagnosing.** ``GetLiveContext``
  returns prose-ish text whose exact shape varies by version, so this
  tries JSON, then YAML, then a line scan, and hands the raw text back
  when all three come up empty. A device list that silently returns
  nothing would be indistinguishable from having no devices.
* **The domain→actions map is a *preference*, not a claim.** It is
  intersected with the tools the connector actually reported, so an
  entry for an intent this Home Assistant doesn't have simply never
  appears. The map is allowed to rot; it can't lie.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("promptly.commands")

# The Home Assistant tool that returns the state of everything exposed
# to Assist. Absent on non-HA connectors, which is how we decide whether
# a connector supports device picking at all.
LIVE_CONTEXT_TOOL = "GetLiveContext"

# Which intents make sense for which kind of entity, best first.
#
# Deliberately a preference list rather than a source of truth: every
# entry is filtered against the connector's real tool catalog before it
# reaches the UI, so a stale line here costs nothing and a missing one
# only means falling back to picking the tool by hand.
DOMAIN_ACTIONS: dict[str, tuple[str, ...]] = {
    "light": ("HassTurnOn", "HassTurnOff", "HassLightSet"),
    "switch": ("HassTurnOn", "HassTurnOff"),
    "fan": ("HassTurnOn", "HassTurnOff"),
    "cover": ("HassTurnOn", "HassTurnOff"),
    "lock": ("HassTurnOn", "HassTurnOff"),
    "climate": ("HassTurnOn", "HassTurnOff", "HassClimateSetTemperature"),
    "vacuum": ("HassTurnOn", "HassTurnOff"),
    "scene": ("HassTurnOn",),
    "script": ("HassTurnOn",),
    "automation": ("HassTurnOn", "HassTurnOff"),
    "media_player": (
        "HassMediaPause",
        "HassMediaUnpause",
        "HassMediaNext",
        "HassMediaPrevious",
        "HassSetVolume",
        "HassMediaPlayerMute",
        "HassMediaPlayerUnmute",
        "HassMediaSearchAndPlay",
        "HassTurnOn",
        "HassTurnOff",
    ),
    "todo": (
        "HassListAddItem",
        "HassListCompleteItem",
        "HassListRemoveItem",
    ),
}

# Anything we don't recognise still gets the two universal intents,
# because on/off is what most entities support and offering nothing
# would be worse than offering the obvious.
FALLBACK_ACTIONS: tuple[str, ...] = ("HassTurnOn", "HassTurnOff")

_MAX_DEVICES = 400


def supports_devices(tool_names: list[str]) -> bool:
    return LIVE_CONTEXT_TOOL in set(tool_names or [])


def _clean(value: Any) -> str:
    text = str(value or "").strip().strip("'\"")
    return text


def _entry(name: str, domain: str = "", area: str = "", state: str = "") -> dict:
    return {
        "name": _clean(name),
        "domain": _clean(domain).lower(),
        "area": _clean(area),
        "state": _clean(state),
    }


def parse_devices(raw: str) -> list[dict]:
    """Best effort: JSON, then YAML, then a line scan.

    Returns ``[]`` when nothing recognisable is found — the caller turns
    that into "couldn't read the list" plus the raw text, rather than an
    empty list that reads as "you have no devices".
    """
    text = (raw or "").strip()
    if not text:
        return []

    for parser in (_from_json, _from_yaml, _from_lines):
        try:
            found = parser(text)
        except Exception:  # noqa: BLE001 — try the next strategy
            continue
        if found:
            return _dedupe(found)[:_MAX_DEVICES]
    return []


def _walk_structure(node: Any, out: list[dict]) -> None:
    """Collect anything that looks like an entity from nested data."""
    if isinstance(node, dict):
        # HA uses "names" (plural) for the friendly name; accept both.
        name = node.get("names") or node.get("name")
        if name and not isinstance(name, (dict, list)):
            out.append(
                _entry(
                    name,
                    node.get("domain", ""),
                    node.get("areas") or node.get("area") or "",
                    node.get("state", ""),
                )
            )
        for value in node.values():
            _walk_structure(value, out)
    elif isinstance(node, list):
        for item in node:
            _walk_structure(item, out)


def _from_json(text: str) -> list[dict]:
    start, end = text.find("{"), text.rfind("}")
    alt_start, alt_end = text.find("["), text.rfind("]")
    if alt_start != -1 and (start == -1 or alt_start < start):
        start, end = alt_start, alt_end
    if start == -1 or end <= start:
        return []
    out: list[dict] = []
    _walk_structure(json.loads(text[start : end + 1]), out)
    return out


def _from_yaml(text: str) -> list[dict]:
    import yaml

    # Drop any leading prose before the first list/mapping line, which
    # is what makes the whole document fail to parse otherwise.
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.lstrip().startswith(("-", "{", "[")) or ":" in line:
            text = "\n".join(lines[i:])
            break
    out: list[dict] = []
    _walk_structure(yaml.safe_load(text), out)
    return out


_KEY_RE = re.compile(
    r"^\s*-?\s*(names?|domain|areas?|state)\s*:\s*(.+?)\s*$", re.IGNORECASE
)


def _from_lines(text: str) -> list[dict]:
    """Last resort: scan ``key: value`` lines and split on repeats.

    A second ``name:`` means a new entity started, which is the only
    reliable record boundary in a format that may not be valid YAML at
    all.
    """
    out: list[dict] = []
    current: dict[str, str] = {}

    def flush() -> None:
        if current.get("name"):
            out.append(
                _entry(
                    current.get("name", ""),
                    current.get("domain", ""),
                    current.get("area", ""),
                    current.get("state", ""),
                )
            )
        current.clear()

    for line in text.splitlines():
        found = _KEY_RE.match(line)
        if not found:
            continue
        key = found.group(1).lower().rstrip("s") if found.group(1).lower() in (
            "names",
            "areas",
        ) else found.group(1).lower()
        key = {"names": "name", "areas": "area"}.get(key, key)
        if key == "name" and current.get("name"):
            flush()
        current[key] = found.group(2)
    flush()
    return out


def _dedupe(devices: list[dict]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for d in devices:
        if not d["name"]:
            continue
        key = (d["name"].lower(), d["domain"])
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def actions_for(domain: str, available: list[str]) -> list[str]:
    """Intents worth offering for ``domain``, filtered to what exists.

    The filter is the important half. It means the map above can be
    wrong or out of date without ever offering an action that would fail
    — the connector's own catalog has the final say.
    """
    have = set(available or [])
    preferred = DOMAIN_ACTIONS.get((domain or "").lower(), FALLBACK_ACTIONS)
    ordered = [name for name in preferred if name in have]
    if ordered:
        return ordered
    return [name for name in FALLBACK_ACTIONS if name in have]

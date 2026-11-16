"""Simple device commands, understood without a model.

"Turn off the kitchen lights", "set lounge to 30%", "pause the music": said
to the assistant, these are worked out here, on the server, from the home's
own rooms and device names. Nothing is sent to a model, so they happen at
once and cost nothing.

**It never guesses.** The whole sentence has to fit one of a few shapes, and
the room or device named in it has to be exactly one thing in the person's
homes. Anything else (two rooms that could be meant, a name it doesn't know,
a sentence with more in it) returns ``None`` and the model answers instead,
with the home tools (``chat/tools/home.py``), where it can ask which.

Pure: :func:`parse` takes the words and the devices and returns a
:class:`Plan`; ``assistant.py`` fetches the devices and carries the plan out.
Locks, garage doors, gates and alarms are never in a plan.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# What "turn on" and "turn off" may switch by name.
SWITCHED = frozenset({"light", "switch", "input_boolean", "fan"})
# Rooms hold other things that take a number; a bare "set lounge to 30%" is
# only the lights when nothing else there could be meant.
TAKES_PERCENT = frozenset({"media_player", "fan", "cover"})

# Named colours, as the light's red, green and blue.
COLOURS: dict[str, list[int]] = {
    "red": [255, 0, 0],
    "green": [0, 200, 60],
    "blue": [0, 80, 255],
    "yellow": [255, 220, 0],
    "orange": [255, 130, 0],
    "purple": [150, 50, 255],
    "pink": [255, 100, 180],
    "cyan": [0, 220, 255],
    "turquoise": [0, 220, 190],
    "magenta": [255, 0, 200],
}
# Whites, as a warmth in kelvin.
WHITES: dict[str, int] = {
    "warm white": 2700,
    "warm": 2700,
    "soft white": 3000,
    "white": 4000,
    "neutral white": 4000,
    "cool white": 5500,
    "cool": 5500,
    "daylight": 6500,
    "cold white": 6500,
}
VOLUME_STEP = 10
MAX_STEPS = 40


@dataclass
class Step:
    """One thing to ask a box. ``device`` is the entity (as ``assistant.py``
    gives it) for a ``do``; ``area`` the room for ``lights``."""

    kind: str  # "do" | "lights"
    box_id: Any
    device: dict[str, Any] | None = None
    action: str = ""
    value: Any = None
    area: str = ""


@dataclass
class Plan:
    say: str
    steps: list[Step] = field(default_factory=list)
    # Nothing to do, and why (the box is offline): said, not run.
    problem: bool = False


# ------------------------------------------------------------------ words
_LEAD = re.compile(r"^(?:(?:hey|hi|ok|okay)\s+)?promptly\b[\s,]*")
_POLITE_START = re.compile(r"^(?:please|can you|could you|would you|will you|can you please|could you please)\s+")
_POLITE_END = re.compile(r"\s+(?:please|thanks|thank you|for me|now)$")
_NUMBER_WORDS = {
    "zero": 0, "ten": 10, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90, "a hundred": 100, "one hundred": 100, "hundred": 100,
}


def norm(text: Any) -> str:
    """Lower case, no punctuation, single spaces; "30%" becomes "30 percent"."""
    s = str(text or "").lower().replace("’", "'")
    s = s.replace("%", " percent ").replace("per cent", "percent")
    s = re.sub(r"'s\b", "s", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return " ".join(s.split())


def _clean(text: str) -> str:
    s = _LEAD.sub("", norm(text))
    before = None
    while before != s:
        before = s
        s = _POLITE_START.sub("", s)
        s = _POLITE_END.sub("", s)
    return s.strip()


def key(name: Any) -> str:
    """A name the way it's compared: "The Kitchen" and "kitchen" are one."""
    s = norm(name)
    s = re.sub(r"^(?:the|my|our) ", "", s)
    return s


def _bare(k: str) -> str:
    """Without a trailing "light(s)": "kitchen lights" names the kitchen."""
    return re.sub(r" (?:lights|light)$", "", k)


def _room_keys(name: Any) -> set[str]:
    k = key(name)
    keys = {k}
    if k.endswith(" room"):
        keys.add(k[: -len(" room")])
    else:
        keys.add(f"{k} room")
    return {x for x in keys if x}


def _number(word: str) -> int | None:
    if word.isdigit():
        return int(word)
    return _NUMBER_WORDS.get(word)


_NUM = r"(?P<n>\d{1,3}|zero|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a hundred|one hundred|hundred)"


# ------------------------------------------------------------------ finding what's meant
class _Home:
    """The person's devices, indexed for looking names up."""

    def __init__(self, devices: list[dict[str, Any]]) -> None:
        self.devices = [d for d in devices if not d.get("careful")]
        # (home, room id) -> room name
        self.rooms: dict[tuple[str, str], str] = {}
        for d in self.devices:
            if d.get("area") and d.get("room"):
                self.rooms[(str(d["home_id"]), str(d["area"]))] = str(d["room"])

    def in_room(self, room: tuple[str, str], domains: frozenset[str] | set[str]) -> list[dict[str, Any]]:
        return [d for d in self.devices if (str(d["home_id"]), str(d.get("area") or "")) == room and d["domain"] in domains]

    def rooms_called(self, k: str) -> list[tuple[str, str]]:
        return [r for r, name in self.rooms.items() if k in _room_keys(name)]

    def devices_called(self, k: str, domains: frozenset[str] | set[str]) -> list[dict[str, Any]]:
        return [d for d in self.devices if d["domain"] in domains and (key(d["name"]) == k or _bare(key(d["name"])) == _bare(k))]


def _offline(what: str) -> Plan:
    return Plan(f"I can't reach {what} right now. The home box is offline.", problem=True)


def _label(room_name: str) -> str:
    return room_name.strip() or "Those"


# ------------------------------------------------------------------ lights
def _lights_target(home: _Home, target: str, *, needs_word: bool) -> tuple[str, Any] | None:
    """What a lights sentence names: ``("room", (home, area))``, ``("device",
    entity)``, ``("all", None)`` or None when it isn't exactly one thing.
    ``needs_word``: a room only counts when "lights" was said ("turn off the
    kitchen" could mean everything in it)."""
    k = key(target)
    if not k:
        return None
    if k in ("all lights", "all the lights", "all of the lights", "every light", "lights everywhere", "all lights everywhere"):
        homes = {str(d["home_id"]) for d in home.devices if d["domain"] == "light"}
        return ("all", None) if len(homes) == 1 else None
    if k in ("lights", "light"):
        # "Turn off the lights" with one room of lights means that room.
        rooms = {(str(d["home_id"]), str(d.get("area") or "")) for d in home.devices if d["domain"] == "light"}
        if len(rooms) == 1 and next(iter(rooms))[1]:
            return ("room", next(iter(rooms)))
        return None
    said_lights = k != _bare(k)
    devices = home.devices_called(k, SWITCHED if not said_lights else frozenset({"light"}))
    rooms = [r for r in home.rooms_called(_bare(k)) if home.in_room(r, {"light"})]
    if said_lights or not needs_word:
        if len(rooms) == 1:
            # A light named after its room is that room's lights.
            if all((str(d["home_id"]), str(d.get("area") or "")) == rooms[0] and d["domain"] == "light" for d in devices):
                return ("room", rooms[0])
            return None
        if len(rooms) > 1:
            return None
    elif rooms and not devices:
        return None
    if len(devices) == 1:
        return ("device", devices[0])
    return None


def _room_lights(home: _Home, room: tuple[str, str]) -> list[dict[str, Any]]:
    return home.in_room(room, {"light"})


def _lights_on_off(home: _Home, target: str, on: bool, *, needs_word: bool = True) -> Plan | None:
    hit = _lights_target(home, target, needs_word=needs_word)
    if hit is None:
        return None
    word = "on" if on else "off"
    what, which = hit
    if what == "device":
        d = which
        if not d.get("live"):
            return _offline(d["name"])
        return Plan(f"{d['name']} {word}.", [Step("do", d["box_id"], device=d, action="turn_on" if on else "turn_off")])
    if what == "room":
        lights = _room_lights(home, which)
        if not all(d.get("live") for d in lights):
            return _offline(f"the {home.rooms[which]} lights")
        boxes = dict.fromkeys(d["box_id"] for d in lights)
        return Plan(f"{_label(home.rooms[which])} lights {word}.", [Step("lights", b, area=which[1], action="turn_on" if on else "turn_off") for b in boxes])
    lights = [d for d in home.devices if d["domain"] == "light"]
    if not lights:
        return None
    if not all(d.get("live") for d in lights):
        return _offline("the lights")
    steps: list[Step] = []
    seen: set[tuple[Any, str]] = set()
    for d in lights:
        area = str(d.get("area") or "")
        if area:
            if (d["box_id"], area) not in seen:
                seen.add((d["box_id"], area))
                steps.append(Step("lights", d["box_id"], area=area, action="turn_on" if on else "turn_off"))
        else:
            steps.append(Step("do", d["box_id"], device=d, action="turn_on" if on else "turn_off"))
    if len(steps) > MAX_STEPS:
        return None
    return Plan(f"All the lights {word}.", steps)


def _lights_set(home: _Home, target: str, value: dict[str, Any], said: str) -> Plan | None:
    """Brightness, a colour or a warmth for a room's lights or one light."""
    k = key(target)
    said_lights = k != _bare(k)
    hit = _lights_target(home, target, needs_word=False)
    if hit is None or hit[0] == "all":
        return None
    what, which = hit
    if what == "device":
        d = which
        if d["domain"] != "light":
            return None
        if not d.get("live"):
            return _offline(d["name"])
        return Plan(f"{d['name']} {said}.", [Step("do", d["box_id"], device=d, action="set", value=value)])
    if not said_lights and "bri" in value and home.in_room(which, TAKES_PERCENT):
        # A speaker or a blind in there takes a number too: don't guess.
        return None
    lights = _room_lights(home, which)
    if not lights or len(lights) > MAX_STEPS:
        return None
    if not all(d.get("live") for d in lights):
        return _offline(f"the {home.rooms[which]} lights")
    return Plan(f"{_label(home.rooms[which])} lights {said}.", [Step("do", d["box_id"], device=d, action="set", value=value) for d in lights])


_ON_OFF = [
    re.compile(r"^(?:turn|switch|put) (?P<w>on|off) (?P<x>.+)$"),
    re.compile(r"^(?:turn|switch|put) (?P<x>.+) (?P<w>on|off)$"),
    re.compile(r"^(?P<x>.+) (?P<w>on|off)$"),
]
_PERCENT = [
    re.compile(rf"^(?:set|dim|brighten|turn|put|make|change) (?P<x>.+?) (?:down |up )?(?:to|at) {_NUM} percent(?: brightness)?$"),
    re.compile(rf"^(?P<x>.+?) (?:to|at) {_NUM} percent(?: brightness)?$"),
    re.compile(rf"^(?:set |change |turn )?(?:the )?brightness (?:of|in|for) (?P<x>.+?) (?:to|at) {_NUM}(?: percent)?$"),
    re.compile(rf"^(?:dim|brighten) (?P<x>.+?) (?:down |up )?(?:to|at) {_NUM}$"),
    re.compile(rf"^(?:set|change|turn|put) (?P<x>.+?) brightness (?:to|at) {_NUM}$"),
]
_SHADE = "|".join(sorted({*COLOURS, *WHITES}, key=len, reverse=True))
_COLOUR = [
    re.compile(rf"^(?:set|turn|make|change|put) (?P<x>.+?) (?:to |on )?(?P<c>{_SHADE})$"),
    re.compile(rf"^(?P<x>.+?) (?:to )?(?P<c>{_SHADE})$"),
]


def _percent(home: _Home, x: str, n: int | None) -> Plan | None:
    if n is None or not 0 <= n <= 100:
        return None
    speakers = home.devices_called(key(x), {"media_player"})
    if speakers and not home.devices_called(key(x), {"light"}):
        # "Set the kitchen speaker to 30%": its volume.
        return _volume(home, [d for d in speakers if not d.get("grp")] or speakers, n)
    if n == 0:
        return _lights_on_off(home, x, False, needs_word=False)
    return _lights_set(home, x, {"bri": n}, f"at {n}%")


def _lights(home: _Home, s: str) -> Plan | None:
    """Every shape the sentence fits is tried: the first whose room or device
    is really there wins."""
    for shape in _PERCENT:
        m = shape.match(s)
        plan = _percent(home, m.group("x"), _number(m.group("n"))) if m else None
        if plan is not None:
            return plan
    for shape in _COLOUR:
        m = shape.match(s)
        if m:
            c = m.group("c")
            value = {"rgb": COLOURS[c]} if c in COLOURS else {"k": WHITES[c]}
            plan = _lights_set(home, m.group("x"), value, c)
            if plan is not None:
                return plan
    for shape in _ON_OFF:
        m = shape.match(s)
        # "Kitchen lights off" needs no verb; a bare "x off" must name lights or one device.
        plan = _lights_on_off(home, m.group("x"), m.group("w") == "on") if m else None
        if plan is not None:
            return plan
    return None


# ------------------------------------------------------------------ speakers
def _speakers(home: _Home, where: str | None, action: str) -> list[dict[str, Any]] | None:
    """The one speaker meant, or None."""
    players = [d for d in home.devices if d["domain"] == "media_player"]
    if where:
        k = key(where)
        k = re.sub(r" (?:speaker|speakers)$", "", k) or k
        named = [d for d in players if key(d["name"]) in (k, f"{k} speaker") or re.sub(r" speaker$", "", key(d["name"])) == k]
        if len(named) == 1:
            return named
        if named:
            return None
        rooms = home.rooms_called(k)
        if len(rooms) != 1:
            return None
        here = [d for d in home.in_room(rooms[0], {"media_player"}) if not d.get("grp")]
        return here if len(here) == 1 else None
    # Nothing named: the one that's playing (paused, for "play"). Speakers
    # playing together as a group count once, as the group.
    want = "paused" if action == "play" else "playing"
    busy = [d for d in players if d.get("state") == want]
    grouped = [d for d in busy if d.get("grp")]
    if len(grouped) == 1:
        return grouped
    if len(busy) == 1:
        return busy
    if not busy and action in ("volume", "up", "down", "unmute", "preset"):
        # Nothing playing: the volume of the home's only speaker.
        single = [d for d in players if not d.get("grp")]
        return single if len(single) == 1 else None
    return None


def _can(d: dict[str, Any], need: str) -> bool:
    can = (d.get("x") or {}).get("can")
    return not isinstance(can, list) or need in can


def _volume(home: _Home, who: list[dict[str, Any]] | None, n: int) -> Plan | None:
    if not who or len(who) != 1 or not 0 <= n <= 100 or not _can(who[0], "vol"):
        return None
    d = who[0]
    if not d.get("live"):
        return _offline(d["name"])
    return Plan(f"Volume {n} on {d['name']}.", [Step("do", d["box_id"], device=d, action="volume", value=n)])


_IN = r"(?: (?:in|on|at) (?P<x>.+))?"
_MUSIC = r"(?: (?:the )?(?:music|song|track|playback|audio|speaker|speakers|it))?"
_MEDIA: list[tuple[str, re.Pattern[str]]] = [
    ("pause", re.compile(rf"^pause{_MUSIC}{_IN}$")),
    ("pause", re.compile(rf"^stop (?:the )?(?:music|song|track|playback|audio){_IN}$")),
    ("pause", re.compile(r"^pause (?P<x>.+)$")),
    ("play", re.compile(rf"^(?:resume|unpause|play){_MUSIC}{_IN}$")),
    ("play", re.compile(rf"^(?:continue|carry on with) (?:the )?(?:music|song|track|playback){_IN}$")),
    ("next", re.compile(rf"^(?:next|skip)(?: (?:this|the))?(?: (?:song|track|one))?{_IN}$")),
    ("next", re.compile(rf"^play (?:the )?next (?:song|track|one){_IN}$")),
    ("prev", re.compile(rf"^(?:previous|last) (?:song|track|one){_IN}$")),
    ("prev", re.compile(rf"^(?:go back|play (?:the )?(?:previous|last) (?:song|track|one)){_IN}$")),
    ("mute", re.compile(rf"^mute{_MUSIC}{_IN}$")),
    ("unmute", re.compile(rf"^unmute{_MUSIC}{_IN}$")),
    ("volume", re.compile(rf"^(?:set |turn |put |change )?(?:the )?volume (?:to |at )?{_NUM}(?: percent)?{_IN}$")),
    ("volume", re.compile(rf"^(?:set |turn |put |change )?(?:the )?volume (?:in|on|of|at) (?P<x>.+?) (?:to|at) {_NUM}(?: percent)?$")),
    ("up", re.compile(rf"^(?:(?:turn )?(?:the )?volume up|turn (?:it|the music) up|turn up (?:the )?(?:volume|music)|louder){_IN}$")),
    ("down", re.compile(rf"^(?:(?:turn )?(?:the )?volume down|turn (?:it|the music) down|turn down (?:the )?(?:volume|music)|quieter){_IN}$")),
    ("preset", re.compile(rf"^play (?:preset|favourite|favorite)(?: number)? (?P<n>\d{{1,2}}){_IN}$")),
]
_SAID = {"pause": "Paused", "play": "Playing", "next": "Next song", "prev": "Previous song", "mute": "Muted", "unmute": "Sound back on"}
_NEED = {"pause": "pause", "play": "play", "next": "next", "prev": "prev", "mute": "mute", "unmute": "mute", "preset": "preset"}


def _media(home: _Home, s: str) -> Plan | None:
    for what, shape in _MEDIA:
        m = shape.match(s)
        if not m:
            continue
        groups = m.groupdict()
        who = _speakers(home, groups.get("x"), what)
        if not who or len(who) != 1:
            return None
        d = who[0]
        if what == "volume":
            n = _number(groups["n"])
            return None if n is None else _volume(home, who, n)
        if what in ("up", "down"):
            now = (d.get("x") or {}).get("vol")
            if not isinstance(now, (int, float)):
                return None
            return _volume(home, who, max(0, min(100, int(now) + (VOLUME_STEP if what == "up" else -VOLUME_STEP))))
        if what == "preset":
            n = int(groups["n"])
            # Only a speaker that says it has presets (a WiiM).
            if not 1 <= n <= 20 or "preset" not in ((d.get("x") or {}).get("can") or []):
                return None
            if not d.get("live"):
                return _offline(d["name"])
            return Plan(f"Playing preset {n} on {d['name']}.", [Step("do", d["box_id"], device=d, action="preset", value=n)])
        if what == "pause" and not _can(d, "pause"):
            what = "stop"
            if not _can(d, "stop"):
                return None
        elif not _can(d, _NEED.get(what, what)):
            return None
        if not d.get("live"):
            return _offline(d["name"])
        if what in ("mute", "unmute"):
            return Plan(f"{_SAID[what]} on {d['name']}.", [Step("do", d["box_id"], device=d, action="mute", value=what == "mute")])
        return Plan(f"{_SAID.get(what, 'Stopped')} on {d['name']}.", [Step("do", d["box_id"], device=d, action=what)])
    return None


# ------------------------------------------------------------------ scenes
_SCENE = [
    (True, re.compile(r"^(?:turn on|switch on|activate|run|start|set|play)(?: the)? (?P<x>.+?) scene$")),
    (True, re.compile(r"^(?P<x>.+?) scene$")),
    (False, re.compile(r"^(?:activate|run|start)(?: the)? (?P<x>.+)$")),
    (False, re.compile(r"^(?:turn on|switch on|set)(?: the)? (?P<x>.+)$")),
]


def _scene(home: _Home, s: str) -> Plan | None:
    scenes = [d for d in home.devices if d["domain"] == "scene"]
    if not scenes:
        return None
    for _said_scene, shape in _SCENE:
        m = shape.match(s)
        if not m:
            continue
        k = key(m.group("x"))
        hits = [d for d in scenes if key(d["name"]) == k]
        if len(hits) != 1:
            continue
        d = hits[0]
        if not d.get("live"):
            return _offline(d["name"])
        return Plan(f"{d['name']} is on.", [Step("do", d["box_id"], device=d, action="run")])
    return None


# ------------------------------------------------------------------ the one way in
_QUESTION = re.compile(r"^(?:what|whats|why|who|when|where|how|is|are|did|does|do|which|tell|should|if)\b")


_MAYBE = re.compile(
    r"\b(?:lights?|lamps?|turn|switch|dim|brighten|brightness|volume|pause|unpause|play|resume|skip|next|previous|mute|unmute|"
    r"scene|percent|louder|quieter|music|song|track|activate|on|off)\b"
)


def maybe(text: str) -> bool:
    """Cheap, before any lookup: could this be a device command at all?"""
    s = _clean(text)
    return bool(s) and len(s) <= 120 and not _QUESTION.match(s) and bool(_MAYBE.search(s))


def parse(text: str, devices: list[dict[str, Any]]) -> Plan | None:
    """The plan for a simple command, or None: let the model answer."""
    s = _clean(text)
    if not s or len(s) > 120 or not devices or _QUESTION.match(s):
        return None
    home = _Home(devices)
    if not home.devices:
        return None
    for attempt in (_media, _lights, _scene):
        plan = attempt(home, s)
        if plan is not None:
            return plan
    return None

"""The home from any chat, typed or spoken: "are the kitchen lights on?",
"make the lounge warm white at 40%", "turn the music down a bit".

* ``home_devices``: the rooms and devices of the homes the person is in, and
  what each is doing now.
* ``home_control``: switch or set the everyday ones (lights, plugs, fans,
  scenes, speakers).

Only the person's own homes (``app/home/assistant.py``); an admin gets no
more than anyone. Locks, garage doors, gates and alarms are listed but never
operated from here: the tool says to use the Home page. On a turn that read
outside content, a change waits for the person's yes like any other write
(``guard_write``).

Simple commands never reach these tools on a spoken turn: they're done
without the model (``app/home/quick.py``).

Category ``home``: with the Tools toggle, for anyone in a home.
"""
from __future__ import annotations

import re
from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult, guard_write

_LIGHTS = frozenset({"light"})
_SWITCHED = frozenset({"light", "switch", "input_boolean", "fan"})
_SPEAKERS = frozenset({"media_player"})
_HEX = re.compile(r"^#?([0-9a-f]{6})$", re.I)

ACTIONS = (
    "turn_on", "turn_off", "set_light", "run_scene", "play", "pause", "stop", "next", "previous",
    "set_volume", "mute", "unmute", "play_preset",
)
_MEDIA = {"play": "play", "pause": "pause", "stop": "stop", "next": "next", "previous": "prev"}


def _where(d: dict[str, Any], many_homes: bool) -> str:
    bits = [d["room"]] if d.get("room") else []
    if many_homes:
        bits.append(str(d["home"]))
    return f" ({', '.join(bits)})" if bits else ""


def _doing(d: dict[str, Any]) -> str:
    """What a device is doing, in a few words."""
    x = d.get("x") or {}
    state = str(d.get("state") or "")
    if state in ("unavailable", "unknown", ""):
        return "not reachable"
    if d["domain"] == "light":
        if state != "on":
            return "off"
        return f"on at {d['bri']}%" if isinstance(d.get("bri"), int) else "on"
    if d["domain"] == "media_player":
        bits = [state]
        if x.get("title"):
            bits.append(f"“{x['title']}”" + (f" by {x['artist']}" if x.get("artist") else ""))
        if isinstance(x.get("vol"), (int, float)):
            bits.append(f"volume {int(x['vol'])}")
        if x.get("muted"):
            bits.append("muted")
        return ", ".join(bits)
    if d["domain"] == "scene":
        return "scene"
    if d["domain"] == "climate" and isinstance(x.get("cur"), (int, float)):
        return f"{state}, {x['cur']}° now"
    return state + (f" {d['unit']}" if d.get("unit") else "")


def _colour(raw: Any) -> dict[str, Any]:
    from app.home import quick

    text = quick.norm(raw)
    if text in quick.COLOURS:
        return {"rgb": quick.COLOURS[text]}
    if text in quick.WHITES:
        return {"k": quick.WHITES[text]}
    m = _HEX.match(str(raw or "").strip())
    if m:
        h = m.group(1)
        return {"rgb": [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]}
    raise ToolError("Use a plain colour name (red, blue, warm white, daylight…) or a hex colour like #ff8800.")


def _one(found: list[dict[str, Any]], target: str, what: str, many_homes: bool) -> dict[str, Any]:
    if len(found) == 1:
        return found[0]
    if not found:
        raise ToolError(f"There's no {what} called “{target}”. Call home_devices to see what there is.")
    names = "; ".join(f"{d['name']}{_where(d, many_homes)}" for d in found[:8])
    raise ToolError(f"More than one {what} could be “{target}”: {names}. Ask which one they mean.")


class HomeDevicesTool(Tool):
    name = "home_devices"
    category = "home"
    max_per_turn = 4
    timeout_seconds = 10.0
    max_content_chars = 12_000
    description = (
        "The user's home: its rooms and smart devices (lights, speakers, scenes, plugs…) and what each is doing right "
        "now. Use for 'are the lights on?', 'what's playing?', or to find the exact name before home_control."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"room": {"type": "string", "description": "Only this room (its name)."}},
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.home import assistant, quick

        devices = await assistant.devices_for(ctx.db, ctx.user.id)
        if not devices:
            raise ToolError("They aren't in a home with any devices yet. Devices are added on the Home page.")
        many_homes = len({d["home_id"] for d in devices}) > 1
        want = quick.key(args.get("room")) if args.get("room") else ""
        if want:
            devices = [d for d in devices if want in quick.key(d.get("room") or "")]
            if not devices:
                raise ToolError(f"There's no room called “{args.get('room')}”.")
        rooms: dict[str, list[dict[str, Any]]] = {}
        for d in devices:
            head = (d.get("room") or "No room yet") + (f" · {d['home']}" if many_homes else "")
            rooms.setdefault(head, []).append(d)
        lines: list[str] = []
        if any(not d.get("live") for d in devices):
            lines.append("(The home box is offline: this is what it last said, and nothing can be switched right now.)")
        for head, items in rooms.items():
            lines.append(f"{head}:")
            for d in sorted(items, key=lambda d: (d["domain"], d["name"].lower())):
                kind = {"media_player": "speaker", "input_boolean": "switch", "binary_sensor": "sensor"}.get(d["domain"], d["domain"].replace("_", " "))
                note = " · Home page only" if d.get("careful") or d["domain"] not in assistant.CONTROLLED and d["domain"] not in ("sensor", "binary_sensor") else ""
                lines.append(f"- {d['name']} [{kind}] {_doing(d)}{note}")
        return ToolResult(content="\n".join(lines), meta={"result_count": len(devices)})


class HomeControlTool(Tool):
    name = "home_control"
    category = "home"
    max_per_turn = 8
    timeout_seconds = 20.0
    description = (
        "Switch or set something in the user's home: lights (on, off, brightness, colour, warm or cool white), plugs "
        "and fans (on, off), a scene, or a speaker (play, pause, next, previous, volume, mute, a saved preset number). "
        "`target` is a device's name or, for lights, a room's name ('Kitchen' means all the kitchen's lights). It "
        "happens straight away. If more than one thing fits, it tells you; ask the user which. It cannot unlock, open "
        "or disarm anything."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "target": {"type": "string", "description": "A device name, a room name (lights), or 'all lights'. May be left out for a speaker when only one is playing."},
            "action": {"type": "string", "enum": list(ACTIONS)},
            "brightness": {"type": "integer", "description": "set_light / turn_on: 1 to 100."},
            "colour": {"type": "string", "description": "set_light: a colour name (red, blue, warm white, cool white, daylight…) or #rrggbb."},
            "volume": {"type": "integer", "description": "set_volume: 0 to 100."},
            "preset": {"type": "integer", "description": "play_preset: the number of a favourite saved on the speaker, 1 to 20."},
        },
        "required": ["action"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.home import assistant, quick

        guard_write(ctx, "changing things at home")
        action = str(args.get("action") or "")
        if action not in ACTIONS:
            raise ToolError("Unknown action.")
        target = str(args.get("target") or "").strip()[:120]
        devices = await assistant.devices_for(ctx.db, ctx.user.id)
        # Nothing of ours holds a database connection while a box is asked.
        await ctx.db.commit()
        if not devices:
            raise ToolError("They aren't in a home with any devices yet. Devices are added on the Home page.")
        many_homes = len({d["home_id"] for d in devices}) > 1
        try:
            if action in ("turn_on", "turn_off", "set_light"):
                said = await self._lights(assistant, quick, devices, target, action, args, many_homes)
            elif action == "run_scene":
                d = _one(assistant.find(devices, target, {"scene"}), target, "scene", many_homes)
                await assistant.act(d, "run")
                said = f"{d['name']} is on."
            else:
                said = await self._speaker(assistant, devices, target, action, args, many_homes)
        except assistant.CantDo as e:
            raise ToolError(str(e)) from e
        return ToolResult(content=f"Done: {said}", meta={"summary": said, "spoken": said})

    async def _lights(self, assistant: Any, quick: Any, devices: list[dict[str, Any]], target: str, action: str, args: dict[str, Any], many_homes: bool) -> str:
        value: dict[str, Any] = {}
        bri = args.get("brightness")
        if isinstance(bri, (int, float)) and not isinstance(bri, bool):
            if not 1 <= bri <= 100:
                raise ToolError("Brightness is 1 to 100.")
            value["bri"] = int(bri)
        if args.get("colour"):
            value.update(_colour(args["colour"]))
        if action == "set_light" and not value:
            raise ToolError("Say a brightness or a colour.")
        setting = bool(value) and action != "turn_off"
        said = " and ".join(
            ([f"at {value['bri']}%"] if "bri" in value else []) + ([quick.norm(args.get("colour"))] if args.get("colour") else [])
        ) if setting else ("off" if action == "turn_off" else "on")
        on = action != "turn_off"
        if quick.key(target) in ("all lights", "all the lights", "every light", "lights", "the lights", "all"):
            lights = [d for d in devices if d["domain"] == "light" and not d.get("careful")]
            if len({d["home_id"] for d in lights}) != 1:
                raise ToolError("Say which room or light." if not lights else "They're in more than one home: ask which home.")
            if quick.key(target) in ("lights", "the lights") and len({d.get("area") for d in lights}) > 1:
                rooms = ", ".join(sorted({d["room"] for d in lights if d.get("room")}))
                raise ToolError(f"Which room's lights? There are lights in: {rooms}. Or use target 'all lights' if they mean every light.")
            await self._many(assistant, lights, setting, value, on)
            return f"All the lights {said}."
        kinds = _LIGHTS if setting else _SWITCHED
        exact = [d for d in assistant.find(devices, target, kinds) if quick.key(d["name"]) == quick.key(target) or d["id"] == target]
        rooms = assistant.rooms_called(devices, target)
        rooms = [r for r in rooms if any(d["domain"] == "light" and d["box_id"] == r[1] and str(d.get("area")) == r[2] for d in devices)]
        if len(exact) == 1 and not (quick.key(target).endswith(("lights", "light")) and len(rooms) == 1):
            d = exact[0]
            await assistant.act(d, "set" if setting else action, value if setting else None)
            return f"{d['name']} {said}."
        if len(rooms) == 1:
            _home, box, area, name = rooms[0]
            lights = [d for d in devices if d["domain"] == "light" and d["box_id"] == box and str(d.get("area")) == area]
            if setting:
                await self._many(assistant, lights, True, value, True)
            else:
                await assistant.room_lights(box, area, on)
            return f"{name} lights {said}."
        if len(rooms) > 1:
            raise ToolError("More than one room could be meant: " + ", ".join(r[3] for r in rooms[:8]) + ". Ask which.")
        d = _one(assistant.find(devices, target, kinds), target, "light or switch" if not setting else "light", many_homes)
        await assistant.act(d, "set" if setting else action, value if setting else None)
        return f"{d['name']} {said}."

    @staticmethod
    async def _many(assistant: Any, lights: list[dict[str, Any]], setting: bool, value: dict[str, Any], on: bool) -> None:
        import asyncio

        if not lights:
            raise ToolError("There are no lights there.")
        if len(lights) > 60:
            raise ToolError("That's too many lights at once: do it a room at a time.")
        done = await asyncio.gather(
            *(assistant.act(d, "set" if setting else ("turn_on" if on else "turn_off"), value if setting else None) for d in lights),
            return_exceptions=True,
        )
        failed = [r for r in done if isinstance(r, BaseException)]
        if failed and len(failed) == len(done):
            raise failed[0] if isinstance(failed[0], assistant.CantDo) else ToolError("That didn't work.")
        if failed:
            raise ToolError(f"{len(done) - len(failed)} of {len(done)} lights changed; the rest didn't answer.")

    async def _speaker(self, assistant: Any, devices: list[dict[str, Any]], target: str, action: str, args: dict[str, Any], many_homes: bool) -> str:
        speakers = [d for d in devices if d["domain"] == "media_player"]
        if target:
            found = assistant.find(speakers, target, _SPEAKERS)
            if not found:
                # A room with one speaker in it.
                rooms = assistant.rooms_called(devices, target)
                if len(rooms) == 1:
                    found = [d for d in speakers if d["box_id"] == rooms[0][1] and str(d.get("area")) == rooms[0][2] and not d.get("grp")]
            d = _one(found, target, "speaker", many_homes)
        else:
            want = "paused" if action == "play" else "playing"
            busy = [d for d in speakers if d.get("state") == want]
            pick = [d for d in busy if d.get("grp")] if len([d for d in busy if d.get("grp")]) == 1 else busy
            if len(pick) != 1:
                pick = [d for d in speakers if not d.get("grp")] if len([d for d in speakers if not d.get("grp")]) == 1 else pick
            if len(pick) != 1:
                names = ", ".join(f"{d['name']}{_where(d, many_homes)}" for d in speakers[:8]) or "none"
                raise ToolError(f"Which speaker? Speakers: {names}.")
            d = pick[0]
        if action in _MEDIA:
            await assistant.act(d, _MEDIA[action])
            return {"play": "Playing", "pause": "Paused", "stop": "Stopped", "next": "Next song", "previous": "Previous song"}[action] + f" on {d['name']}."
        if action in ("mute", "unmute"):
            await assistant.act(d, "mute", action == "mute")
            return ("Muted " if action == "mute" else "Sound back on on ") + f"{d['name']}."
        if action == "set_volume":
            vol = args.get("volume")
            if not isinstance(vol, (int, float)) or isinstance(vol, bool) or not 0 <= vol <= 100:
                raise ToolError("Volume is 0 to 100.")
            await assistant.act(d, "volume", int(vol))
            return f"Volume {int(vol)} on {d['name']}."
        preset = args.get("preset")
        if not isinstance(preset, int) or isinstance(preset, bool) or not 1 <= preset <= 20:
            raise ToolError("A preset is a number from 1 to 20.")
        if "preset" not in ((d.get("x") or {}).get("can") or []):
            raise ToolError(f"{d['name']} doesn't have numbered presets. They can start music from their music app, then ask me to pause, skip or change the volume.")
        await assistant.act(d, "preset", preset)
        return f"Playing preset {preset} on {d['name']}."


HOME_TOOLS: list[Tool] = [HomeDevicesTool(), HomeControlTool()]

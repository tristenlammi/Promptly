"""The phone's own actions as chat tools (Talk, WP-T3): set a timer or an
alarm, open the dialler or a text, open a Promptly app, start directions.

Category ``device``: offered only on a spoken turn whose phone said in its
``hello`` that it can do them (``app/talk/tools.py``). They don't happen
here: each is checked the way the phone assistant checks it
(``maps/assistant.py``) and comes back as ``meta.device_action`` for the
phone, which checks it again (``PhoneActions``). ``meta.spoken`` is what's
said. An alarm waits for a yes; calls and texts open for you to press call or
send.
"""
from __future__ import annotations

from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.talk import readback


def _clock(name: str, args: dict[str, Any]) -> dict[str, Any] | None:
    from app.maps.assistant import _clock as clock

    return clock(name, args)


class _DeviceTool(Tool):
    """A phone action. Validated here (the same checks as the phone
    assistant), carried out on the phone, which checks it again
    (``PhoneActions``). ``meta.device_action`` is what the phone gets;
    ``meta.spoken`` is what's said."""

    category = "device"
    timeout_seconds = 10.0
    max_per_turn = 1

    def _talk(self, ctx: ToolContext) -> dict[str, Any]:
        return (ctx.turn or {}).get("talk") or {}

    def _driving(self, ctx: ToolContext) -> bool:
        return bool(self._talk(ctx).get("driving"))


class SetTimerTool(_DeviceTool):
    name = "set_timer"
    description = "Set a timer on their phone. Happens straight away."
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "seconds": {"type": "integer", "description": "How long, in seconds (1 to 86400)."},
            "label": {"type": "string", "description": "Optional name, like pasta."},
        },
        "required": ["seconds"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        action = _clock("set_timer", args)
        if action is None:
            raise ToolError("A timer has to be between a second and a day.")
        said = f"Done, {readback.clock_words(action)}."
        return ToolResult(content=f"Set on their phone: {readback.clock_words(action)}.", meta={"device_action": action, "spoken": said})


class SetAlarmTool(_DeviceTool):
    name = "set_alarm"
    description = "Set an alarm on their phone, on a 24-hour clock. They're asked to confirm first."
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "hour": {"type": "integer", "description": "0 to 23."},
            "minute": {"type": "integer", "description": "0 to 59."},
            "label": {"type": "string", "description": "Optional name, like gym."},
        },
        "required": ["hour"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        action = _clock("set_alarm", args)
        if action is None:
            raise ToolError("That isn't a time an alarm can be set for.")
        said = f"Done, {readback.clock_words(action)}."
        return ToolResult(content=f"Set on their phone: {readback.clock_words(action)}.", meta={"device_action": action, "spoken": said})


class _ReachTool(_DeviceTool):
    calling = True

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps.assistant import DriveState, _reach

        state = DriveState(to={"name": "trip"} if self._driving(ctx) else None)
        wants = {"do": "call" if self.calling else "message", **args}
        got = await _reach(ctx.db, ctx.user, wants, state)
        action = got.get("action")
        meta: dict[str, Any] = {"spoken": got["say"]}
        if action:
            meta["device_action"] = action
        return ToolResult(content=got["say"], meta=meta)


class DialTool(_ReachTool):
    name = "dial"
    description = "Open the phone's dialler to call someone from their contacts, or a number they said. They press call themselves."
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "person": {"type": "string", "description": "Who, as they said it (\"Sam\", \"Mum\")."},
            "number": {"type": "string", "description": "Digits they said, if they gave a number."},
        },
    }


class MessageTool(_ReachTool):
    name = "message"
    calling = False
    description = "Start a text message to someone from their contacts, or a number they said. They press send themselves."
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "person": {"type": "string"},
            "number": {"type": "string"},
            "text": {"type": "string", "description": "What the message says."},
        },
    }


class OpenAppTool(_DeviceTool):
    name = "open_app"
    description = "Open one of their Promptly apps on the phone."
    @property  # type: ignore[override]
    def parameters(self) -> dict[str, Any]:  # the apps list lives with the phone assistant
        from app.maps.assistant import APPS

        return {"type": "object", "properties": {"app": {"type": "string", "enum": list(APPS)}}, "required": ["app"]}

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps.assistant import APPS, WHILE_DRIVING

        app = args.get("app")
        if app not in APPS:
            raise ToolError("I can't open that.")
        if self._driving(ctx):
            return ToolResult(content=WHILE_DRIVING, meta={"spoken": WHILE_DRIVING})
        said = f"Opening {APPS[app]}."
        return ToolResult(content=said, meta={"device_action": {"type": "open_app", "app": app}, "spoken": said})


class NavigateTool(_DeviceTool):
    name = "navigate"
    description = "Start directions in P Maps to a place, a saved place (home, work) or an address. Happens straight away."
    timeout_seconds = 15.0
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"place": {"type": "string", "description": "Where to, as they said it."}},
        "required": ["place"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps.assistant import _called, _stop
        from app.maps.router import find_places

        place = " ".join(str(args.get("place") or "").split())[:200]
        if not place:
            raise ToolError("Where to?")
        rows = [r for r in await find_places(ctx.db, ctx.user, place, None) if r.get("lat") is not None]
        if not rows:
            said = f"I can't find {place}."
            return ToolResult(content=said, meta={"spoken": said})
        best = rows[0]
        said = f"Heading to {_called(best)}."
        # "go" is the action the phone already knows from the assistant.
        return ToolResult(content=said, meta={"device_action": {"type": "go", "stop": _stop(best)}, "spoken": said})


DEVICE_TOOLS: list[Tool] = [SetTimerTool(), SetAlarmTool(), DialTool(), MessageTool(), OpenAppTool(), NavigateTool()]


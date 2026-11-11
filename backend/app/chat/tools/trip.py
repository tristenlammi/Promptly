"""The trip's tools for a spoken turn while driving (Talk phase 2, WP-T9):
``trip_status``, ``check_route``, ``add_stop``, ``end_trip``. Category ``trip``:
offered only on a Talk turn with a trip running. See ``app/talk/drive.py``.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.talk.drive import NOT_NAVIGATING, _zone, clock, state_of, status

logger = logging.getLogger("promptly.talk")


# ---------------------------------------------------------------- the tools
class _DriveTool(Tool):
    category = "trip"
    timeout_seconds = 15.0
    max_per_turn = 1

    @staticmethod
    def talk(ctx: ToolContext) -> dict[str, Any]:
        return (ctx.turn or {}).get("talk") or {}

    def trip(self, ctx: ToolContext) -> dict[str, Any]:
        trip = self.talk(ctx).get("trip")
        if not trip:
            raise ToolError(NOT_NAVIGATING)
        return trip


class TripStatusTool(_DriveTool):
    name = "trip_status"
    description = (
        "Their trip right now: when they'll arrive, how long and how far is left, the traffic delay and the next stop. "
        "Use it for 'how long to go?', 'when will I get there?', 'will I make it by five?'."
    )
    parameters: dict[str, Any] = {"type": "object", "properties": {}}

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        trip = self.trip(ctx)
        tz = self.talk(ctx).get("tz")
        now = clock(datetime.now(timezone.utc).astimezone(_zone(tz)))
        return ToolResult(content=f"It's {now} now. {status(trip, tz)}")


class CheckRouteTool(_DriveTool):
    name = "check_route"
    description = "Is the way ahead clear: closures, crashes and delays on the rest of their route, from live traffic."
    parameters: dict[str, Any] = {"type": "object", "properties": {}}
    timeout_seconds = 20.0

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps.assistant import _check

        trip = self.trip(ctx)
        try:
            said = await _check(ctx.db, ctx.user, state_of(trip))
        except Exception:  # noqa: BLE001 - say it plainly rather than nothing
            logger.warning("talk: checking the route failed", exc_info=True)
            said = "I can't check the road ahead right now."
        return ToolResult(content=said, meta={"spoken": said})


class AddStopTool(_DriveTool):
    name = "add_stop"
    description = (
        "Add a stop on the way: the best place of a kind (fuel, food, coffee, groceries, chemist, toilets, parking, atm, "
        "hotel), or a named or saved place. Happens straight away and says what it adds; one tap takes it off."
    )
    timeout_seconds = 25.0

    @property  # type: ignore[override]
    def parameters(self) -> dict[str, Any]:
        from app.maps import nearby

        return {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": list(nearby.CATEGORIES)},
                "place": {"type": "string", "description": "A place's name, an address, or a saved place (home, work)."},
            },
        }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps import nearby
        from app.maps.assistant import _adding, _candidates
        from app.maps.router import find_places

        trip = self.trip(ctx)
        state = state_of(trip)
        category = args.get("category")
        place = " ".join(str(args.get("place") or "").split())[:200]
        if category in nearby.CATEGORIES:
            rows = await _candidates(category, state)
            if not rows:
                said = f"I can't find any {nearby.CATEGORIES[category]['label'].lower()} on the way."
                return ToolResult(content=said, meta={"spoken": said})
            best = rows[0]
        elif place:
            here = {"lat": state.lat, "lon": state.lon} if state.lat is not None and state.lon is not None else None
            rows = [r for r in await find_places(ctx.db, ctx.user, place, here) if r.get("lat") is not None]
            if not rows:
                said = f"I can't find {place}."
                return ToolResult(content=said, meta={"spoken": said})
            best = rows[0]
            to = state.to or {}
            if here and to.get("lat") is not None:
                detoured = await nearby.with_detours([{**best, "off_m": 0}], here, to)
                best = detoured[0] if detoured else best
        else:
            raise ToolError("Say what kind of stop, or which place.")
        got = _adding(best, state)
        said = got["say"]
        if said.startswith("Adding ") and "adds about" in said:
            said = said.replace(". That adds about", ", adds about", 1)
        return ToolResult(content=said, meta={"spoken": said, "device_action": got["action"]})


class EndTripTool(_DriveTool):
    name = "end_trip"
    description = "Stop navigating, when they say so ('stop navigating', 'end the trip')."
    parameters: dict[str, Any] = {"type": "object", "properties": {}}

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        self.trip(ctx)
        said = "Stopping directions."
        return ToolResult(content=said, meta={"spoken": said, "device_action": {"type": "end_trip"}})


DRIVE_TOOLS: list[Tool] = [TripStatusTool(), CheckRouteTool(), AddStopTool(), EndTripTool()]

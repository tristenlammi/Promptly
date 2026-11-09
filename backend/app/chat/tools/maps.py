"""Maps and your timeline from any chat: "how long to Sam's?", "nearest charger?",
"when was I last at Bunnings?", "where did I go on Saturday?".

Read only (category ``apps``), and only the local map services are asked. Each
tool also attaches a map card (``meta``): the chat shows a chip that opens it in
a window. A timeline is sensitive, so its tools refuse on a turn that read
outside content, where a web page could be steering the question.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

CARD_NOTE = "The user sees a map chip for this that opens it in a window, so don't paste links or coordinates."


async def _find(ctx: ToolContext, query: str, near: dict[str, float] | None = None) -> list[dict[str, Any]]:
    from app.maps.router import find_places

    try:
        return await find_places(ctx.db, ctx.user, query, near)
    except HTTPException as e:
        raise ToolError(str(e.detail)) from e


async def _here(ctx: ToolContext) -> dict[str, Any] | None:
    """Where the user probably is: their latest timeline position, or Home."""
    from app.maps.today import origin

    return await origin(ctx.db, ctx.user, datetime.now(timezone.utc))


def _spot(row: dict[str, Any]) -> dict[str, Any]:
    return {"lat": round(row["lat"], 6), "lon": round(row["lon"], 6), "name": row.get("name") or "Pin", "address": row.get("address")}


class MapsSearchTool(Tool):
    name = "maps_search"
    category = "apps"
    max_per_turn = 4
    timeout_seconds = 20.0
    max_content_chars = 4_000
    description = (
        "Find a place or address, including saved places, 'my car' and people in Contacts. Shows them on a map."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            raise ToolError("Say what to look for.")
        here = await _here(ctx)
        rows = await _find(ctx, query, {"lat": here["lat"], "lon": here["lon"]} if here else None)
        if not rows:
            return ToolResult(content=f"Nothing found for {query}.")
        lines = []
        for row in rows[:8]:
            where = " ({})".format(row["address"]) if row.get("address") else ""
            lines.append(f"- {row['name']}{where}")
        return ToolResult(
            content="\n".join([*lines, CARD_NOTE]),
            meta={"map_card": {"kind": "places", "title": query, "places": [_spot(r) for r in rows[:8]]}},
        )


class MapsDirectionsTool(Tool):
    name = "maps_directions"
    category = "apps"
    max_per_turn = 3
    timeout_seconds = 25.0
    max_content_chars = 2_000
    description = (
        "Distance and time between places, by car, bike or on foot, with live traffic and any crashes or closures on the way when available. Shows the trip on a map."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "to": {"type": "string"},
            "from": {"type": "string", "description": "Leave out for where the user is now."},
            "via": {"type": "array", "items": {"type": "string"}},
            "mode": {"type": "string", "enum": ["drive", "cycle", "walk"]},
        },
        "required": ["to"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps import engine
        from app.maps.planning import plan
        from app.maps.traffic import travel_seconds

        to_text = str(args.get("to") or "").strip()
        from_text = str(args.get("from") or "").strip()
        mode = args.get("mode") if args.get("mode") in engine.COSTING else "drive"
        if not to_text:
            raise ToolError("Say where to.")
        start: dict[str, Any] | None
        if from_text:
            hits = await _find(ctx, from_text)
            if not hits:
                return ToolResult(content=f"Couldn't find {from_text} on the map.")
            start = hits[0]
        else:
            start = await _here(ctx)
            if start is None:
                return ToolResult(content="I don't know where you are, and no Home is saved. Ask where they're starting from.")
        near = {"lat": start["lat"], "lon": start["lon"]}
        stops = [start]
        for text in [*(args.get("via") or [])[:8], to_text]:
            hits = await _find(ctx, str(text), near)
            if not hits:
                return ToolResult(content=f"Couldn't find {text} on the map.")
            stops.append(hits[0])
        try:
            planned = await plan(ctx.db, ctx.user, stops, mode, pins=False)
        except HTTPException as e:
            raise ToolError(str(e.detail)) from e
        has_traffic, routes = planned["traffic"], planned["routes"]
        route = routes[0]
        usual = ""
        if route.get("preferred"):
            quicker = min((r for r in routes[1:]), key=travel_seconds, default=None)
            saves = round((travel_seconds(route) - travel_seconds(quicker)) / 60) if quicker else 0
            usual = " This is their usual way" + (f"; another way would save about {saves} min." if saves >= 1 else ".")
        from app.maps.incidents import spoken

        reported = route.get("incidents") or []
        warnings = " On the way: " + "; ".join(spoken(i) for i in reported[:5]) + "." if reported else ""
        if route.get("avoids"):
            warnings += " This goes around a closed road: " + ", ".join(route["avoids"]) + "."
        minutes = round(travel_seconds(route) / 60)
        adds = round((route.get("traffic") or {}).get("adds_seconds", 0) / 60)
        how = (
            f"in current traffic ({f'traffic adds about {adds} min' if adds else 'no traffic delays'})"
            if has_traffic and route.get("traffic")
            else "from road speeds, without live traffic"
        )
        notes = [w for w, on in (("tolls", route["toll"]), ("a ferry", route["ferry"])) if on]
        names = " to ".join(s["name"] for s in stops)
        return ToolResult(
            content=(
                f"{names} ({mode}): {route['km']:.1f} km, about {minutes} min {how}.{usual}{warnings}"
                f"{' Includes ' + ' and '.join(notes) + '.' if notes else ''} {CARD_NOTE}"
            ),
            meta={"map_card": {"kind": "route", "stops": [_spot(s) for s in stops], "mode": mode, "km": route["km"], "seconds": travel_seconds(route), "adds_seconds": (route.get("traffic") or {}).get("adds_seconds"), "warnings": len(reported)}},
        )


class MapsChargersTool(Tool):
    name = "maps_chargers"
    category = "apps"
    max_per_turn = 2
    timeout_seconds = 20.0
    max_content_chars = 3_000
    description = (
        "EV charging stations near a place, closest first. Live availability isn't known. Shows them on a map."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "near": {"type": "string", "description": "Leave out for near the user."},
            "plug": {"type": "string", "enum": ["Type 2", "CCS2", "CHAdeMO", "Tesla"]},
            "min_kw": {"type": "number"},
        },
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps import data

        centre: dict[str, Any] | None
        if args.get("near"):
            hits = await _find(ctx, str(args["near"]))
            centre = hits[0] if hits else None
        else:
            centre = await _here(ctx)
        if centre is None:
            return ToolResult(content="I don't know where to look. Ask for a place.")
        rows = data.chargers()
        if args.get("plug"):
            rows = [r for r in rows if any(s["type"].startswith(str(args["plug"])) for s in r["sockets"])]
        if args.get("min_kw"):
            rows = [r for r in rows if (r.get("max_kw") or 0) >= float(args["min_kw"])]
        scored = sorted((data.distance_m(centre["lat"], centre["lon"], r["lat"], r["lon"]), i, r) for i, r in enumerate(rows))[:6]
        if not scored:
            return ToolResult(content="No charging stations match that.")
        lines = []
        for metres, _i, r in scored:
            plugs = ", ".join(s["type"] for s in r["sockets"]) or "plugs not recorded"
            power = f", {r['max_kw']:g} kW" if r.get("max_kw") else ""
            lines.append(f"- {r['name']}: {metres / 1000:.1f} km away, {plugs}{power}")
        return ToolResult(
            content="\n".join([*lines, CARD_NOTE]),
            meta={"map_card": {"kind": "places", "title": "Charging stations", "places": [_spot(r) for _m, _i, r in scored]}},
        )


def _guard(ctx: ToolContext) -> None:
    """The private timeline on a turn a page could be steering: it waits for
    the person's yes (the shared guard, ``chat/holds.py``)."""
    from app.chat.tools.base import guard_write

    guard_write(ctx, "reading the timeline")


def _nothing(ctx: ToolContext) -> str:
    from app.maps.timeline import timeline_settings

    if timeline_settings(ctx.user)["timeline_on"]:
        return "Nothing recorded for that time."
    return "Nothing recorded for that time, and the timeline is off. It can be turned on in Maps, under Your timeline."


class TimelineDayTool(Tool):
    name = "timeline_day"
    category = "apps"
    max_per_turn = 3
    timeout_seconds = 25.0
    max_content_chars = 8_000
    description = (
        "Where the user went on a day or days, from their private timeline: stays and journeys, with times and distances. Shows it on a map."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "date": {"type": "string", "description": "YYYY-MM-DD."},
            "end_date": {"type": "string", "description": "Last day, up to 31 days on."},
        },
        "required": ["date"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps.timeline import clock, day_view

        _guard(ctx)
        try:
            first = date.fromisoformat(str(args.get("date"))[:10])
            last = date.fromisoformat(str(args["end_date"])[:10]) if args.get("end_date") else first
        except ValueError as e:
            raise ToolError("Dates must be YYYY-MM-DD.") from e
        if last < first or (last - first).days > 31:
            raise ToolError("Pick a range of up to a month.")
        lines: list[str] = []
        stays: list[dict[str, Any]] = []
        trails: list[list[list[float]]] = []
        km = 0.0
        day = first
        while day <= last:
            view = await day_view(ctx.db, ctx.user, day, photos=False)
            if view["segments"]:
                lines.append(day.strftime("%a %d %b %Y"))
            for s in view["segments"]:
                span = f"{clock(s['start'])} to {clock(s['end'])}"
                if s["type"] == "stay":
                    lines.append(f"- {span}: at {s.get('name') or 'somewhere'}")
                    stays.append({"lat": s["lat"], "lon": s["lon"], "name": s.get("name") or "Somewhere"})
                else:
                    lines.append(f"- {span}: {s['mode']} {s['km']:.1f} km")
                    km += s["km"]
                    step = max(1, len(s["line"]) // 150)
                    trails.append(s["line"][::step] + [s["line"][-1]])
            day += timedelta(days=1)
        if not lines:
            return ToolResult(content=_nothing(ctx))
        lines.append(f"Total travelled: {km:.1f} km.")
        title = first.strftime("%a %d %b") if first == last else f"{first.strftime('%d %b')} to {last.strftime('%d %b')}"
        return ToolResult(
            content="\n".join([*lines, CARD_NOTE]),
            meta={"map_card": {"kind": "timeline", "title": title, "stays": stays[:60], "lines": trails[:60]}},
        )


class TimelineVisitsTool(Tool):
    name = "timeline_visits"
    category = "apps"
    max_per_turn = 3
    timeout_seconds = 25.0
    max_content_chars = 5_000
    description = (
        "When the user was at a place, from their private timeline, newest first."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "place": {"type": "string"},
            "start": {"type": "string", "description": "YYYY-MM-DD."},
            "end": {"type": "string", "description": "YYYY-MM-DD."},
        },
        "required": ["place"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.maps.timeline import clock, visits_near

        _guard(ctx)
        place = str(args.get("place") or "").strip()
        if not place:
            raise ToolError("Say which place.")
        try:
            start = date.fromisoformat(str(args["start"])[:10]) if args.get("start") else None
            end = date.fromisoformat(str(args["end"])[:10]) if args.get("end") else None
        except ValueError as e:
            raise ToolError("Dates must be YYYY-MM-DD.") from e
        here = await _here(ctx)
        hits = await _find(ctx, place, {"lat": here["lat"], "lon": here["lon"]} if here else None)
        if not hits:
            return ToolResult(content=f"Couldn't find {place} on the map.")
        # A chain has many branches: look at the few best matches.
        found: list[dict[str, Any]] = []
        for hit in hits[:5]:
            for v in await visits_near(ctx.db, ctx.user, hit["lat"], hit["lon"], start, end):
                found.append({**v, "place": hit})
        if not found:
            return ToolResult(content=f"No visits to {hits[0]['name']} in the timeline. {_nothing(ctx)}")
        found.sort(key=lambda v: v["start"], reverse=True)
        lines = [
            f"- {v['start'].strftime('%a %d %b %Y')}, {clock(v['start'])} to {clock(v['end'])}: {v['place']['name']}"
            + (f" ({v['place']['address']})" if v["place"].get("address") else "")
            for v in found[:25]
        ]
        if len(found) > 25:
            lines.append(f"…and {len(found) - 25} earlier visits.")
        places = {(v["place"]["lat"], v["place"]["lon"]): v["place"] for v in found}
        return ToolResult(
            content="\n".join([f"{len(found)} visit{'' if len(found) == 1 else 's'}.", *lines, CARD_NOTE]),
            meta={"map_card": {"kind": "places", "title": place, "places": [_spot(p) for p in list(places.values())[:8]]}},
        )

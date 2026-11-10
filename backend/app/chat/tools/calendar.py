"""The calendar from any chat: "what's on this weekend?", "add dinner at
Mum's Sunday 6pm and invite Sam".

* ``calendar_events`` — the person's events in a range (only ones they can
  see: their calendars, and events they're invited to).
* ``calendar_add_event`` — add an event, optionally inviting people.
* ``calendar_change_event`` — move, edit, delete, or answer an invite.
* ``calendar_free_times`` — when the user and others are all free (other
  people's calendars only ever say "not available", never what).

The writes act straight away (invites send notifications), so — like
``use_item`` — they refuse on a turn that read outside content; the person
has to ask again. Event notes written by someone else count as outside
content.

Category ``calendar``: with the Tools toggle, for everyone.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

UTC = timezone.utc
_DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}

_REPEAT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "Only for a repeating event.",
    "properties": {
        "freq": {"type": "string", "enum": ["daily", "weekly", "monthly", "yearly"]},
        "interval": {"type": "integer", "description": "Every N days/weeks/… (default 1)."},
        "weekdays": {"type": "array", "items": {"type": "string"}, "description": "Weekly: e.g. ['mon','wed']."},
        "monthly": {"type": "string", "enum": ["day", "weekday"], "description": "Monthly on the same date, or the same weekday (e.g. 2nd Tuesday)."},
        "until": {"type": "string", "description": "Last date, YYYY-MM-DD."},
        "count": {"type": "integer", "description": "Number of times."},
    },
    "required": ["freq"],
}


_LABEL_SCHEMA: dict[str, Any] = {
    "type": "string",
    "description": "One of the user's own calendar labels by name (e.g. 'Work'); calendar_events lists them. Only the user sees it.",
}
# The fields that change the event itself (a label alone is the user's own).
_CHANGE_KEYS = ("title", "start", "end", "all_day", "location", "description", "add_guests", "remove_guests", "repeat", "stop_repeating")


async def _label(ctx: ToolContext, name: Any):  # noqa: ANN202
    """The user's own label called ``name`` (never anyone else's)."""
    if not isinstance(name, str) or not name.strip():
        return None
    from app.calendars import labels

    lb = await labels.by_name(ctx.db, ctx.user, name)
    if lb is None:
        have = ", ".join(x.name for x in await labels.mine(ctx.db, ctx.user)) or "none yet"
        raise ToolError(f"No label called “{name.strip()}”. Your labels: {have}.")
    return lb


def _repeat(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw.get("freq"):
        return None
    out = dict(raw)
    days = []
    for d in raw.get("weekdays") or []:
        if isinstance(d, int):
            days.append(d)
        elif str(d)[:3].lower() in _DAYS:
            days.append(_DAYS[str(d)[:3].lower()])
    out["weekdays"] = days
    return out


async def _resolve_people(ctx: ToolContext, names: list[str]) -> list[uuid.UUID]:
    """Usernames (or emails) → user ids, exact match, case-insensitive."""
    from sqlalchemy import func, or_, select

    from app.auth.models import User

    ids: list[uuid.UUID] = []
    for raw in names:
        n = str(raw).strip().lstrip("@").lower()
        if not n:
            continue
        rows = (
            await ctx.db.execute(
                select(User).where(User.disabled.is_(False), or_(func.lower(User.username) == n, func.lower(User.email) == n))
            )
        ).scalars().all()
        if len(rows) != 1:
            raise ToolError(f"No one on this Promptly is called “{raw}” — use their exact username.")
        if rows[0].id != ctx.user.id:
            ids.append(rows[0].id)
    return ids


async def _calendar_id(ctx: ToolContext, name: str | None) -> uuid.UUID | None:
    from sqlalchemy import select

    from app.calendars.models import CalCalendar, CalMember

    if not name:
        return None
    rows = (
        await ctx.db.execute(
            select(CalCalendar).join(CalMember, CalMember.calendar_id == CalCalendar.id).where(CalMember.user_id == ctx.user.id)
        )
    ).scalars().all()
    want = name.strip().lower()
    hit = [c for c in rows if c.name.lower() == want] or [c for c in rows if want in c.name.lower()]
    if not hit:
        raise ToolError(f"No calendar called “{name}”. Calendars: " + ", ".join(c.name for c in rows))
    return hit[0].id


def _untrusted(ctx: ToolContext) -> None:
    from app.chat.tools.base import guard_write

    guard_write(ctx, "changing the calendar")


def _fmt_occ(o: dict, tz_name: str, users: dict, cal_names: dict, label_names: dict | None = None) -> str:
    from app.calendars import recur

    if o["all_day"]:
        s, e = date.fromisoformat(o["start"]), date.fromisoformat(o["end"])
        when = f"{s:%a %d %b %Y}" + (f" – {e:%a %d %b}" if e != s else "") + " (all day)"
    else:
        tz = recur.zone(tz_name)
        s = datetime.fromisoformat(o["start"].replace("Z", "+00:00")).astimezone(tz)
        e = datetime.fromisoformat(o["end"].replace("Z", "+00:00")).astimezone(tz)
        when = f"{s:%a %d %b %Y %H:%M}–{e:%H:%M}" if s.date() == e.date() else f"{s:%a %d %b %H:%M} – {e:%a %d %b %H:%M}"
    bits = [f"- {when} · {o['title']}"]
    if o["location"]:
        bits.append(f"@ {o['location']}")
    bits.append(f"[{cal_names.get(o['calendar_id'], 'invited')}]")
    if o["created_by"]:
        bits.append(f"organiser {users.get(o['created_by'], {}).get('username', '?')}")
    if o["attendees"]:
        bits.append("guests " + ", ".join(f"{users.get(a['user_id'], {}).get('username', '?')} ({a['status']})" for a in o["attendees"]))
    if o["my_status"]:
        bits.append(f"your answer: {o['my_status']}")
    if o.get("label_id") and label_names and o["label_id"] in label_names:
        bits.append(f"label {label_names[o['label_id']]}")
    if o["repeat"]:
        bits.append("repeats: " + recur.describe(o["repeat"]))
    line = " · ".join(bits) + f" · event_id {o['event_id']} occurrence {o['occurrence']}"
    if o["description"]:
        line += f"\n  notes: {o['description'][:300]}"
    return line


class CalendarEventsTool(Tool):
    name = "calendar_events"
    category = "calendar"
    max_per_turn = 4
    timeout_seconds = 15.0
    max_content_chars = 16_000
    description = (
        "Look at the user's calendar: their events (own and shared calendars, and events they're invited to) "
        "between two dates, with guests and answers. Use for 'what's on…', 'am I free…', 'when is…'. "
        "Returns event_id and occurrence for calendar_change_event."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "start": {"type": "string", "description": "First day, YYYY-MM-DD (default today)."},
            "end": {"type": "string", "description": "Last day, YYYY-MM-DD (default a week after start)."},
            "query": {"type": "string", "description": "Only events whose title, place or notes contain this."},
        },
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from sqlalchemy import select

        from app.calendars import core, recur
        from app.calendars.models import CalCalendar, CalMember

        tz_name = core.user_tz(ctx.user)
        tz = recur.zone(tz_name)
        today = datetime.now(tz).date()
        try:
            first = date.fromisoformat(str(args.get("start"))[:10]) if args.get("start") else today
            last = date.fromisoformat(str(args.get("end"))[:10]) if args.get("end") else first + timedelta(days=7)
        except ValueError as e:
            raise ToolError("Dates must be YYYY-MM-DD.") from e
        if last < first or (last - first).days > 370:
            raise ToolError("Pick a range of up to a year.")
        start = datetime.combine(first, datetime.min.time(), tz).astimezone(UTC)
        end = datetime.combine(last + timedelta(days=1), datetime.min.time(), tz).astimezone(UTC)
        await core.ensure_personal(ctx.db, ctx.user)
        events = await core.visible_events(ctx.db, ctx.user, start, end)
        occ = await core.occurrences_out(ctx.db, ctx.user, events, start, end)
        q = str(args.get("query") or "").strip().lower()
        if q:
            occ = [o for o in occ if q in o["title"].lower() or q in o["location"].lower() or q in o["description"].lower()]
        cals = (
            await ctx.db.execute(
                select(CalCalendar).join(CalMember, CalMember.calendar_id == CalCalendar.id).where(CalMember.user_id == ctx.user.id)
            )
        ).scalars().all()
        cal_names = {str(c.id): ("own calendar" if c.personal else c.name) for c in cals}
        people = {uuid.UUID(a["user_id"]) for o in occ for a in o["attendees"]} | {uuid.UUID(o["created_by"]) for o in occ if o["created_by"]}
        users = await core.users_map(ctx.db, people)
        if ctx.turn is not None and any(o["description"] and o["created_by"] != str(ctx.user.id) for o in occ):
            ctx.turn["untrusted"] = True  # someone else's words
        head = (
            f"Today is {today:%A %Y-%m-%d}; times are in {tz_name}. "
            f"Calendars: " + ", ".join(cal_names.values()) + f".\nEvents {first} to {last}:"
        )
        from app.calendars import labels

        mine = await labels.mine(ctx.db, ctx.user)
        label_names = {str(lb.id): lb.name for lb in mine}
        if mine:
            head += f"\n(Your labels: {', '.join(lb.name for lb in mine)}.)"
        body = "\n".join(_fmt_occ(o, tz_name, users, cal_names, label_names) for o in occ[:150]) or "(nothing)"
        if len(occ) > 150:
            body += f"\n…and {len(occ) - 150} more — narrow the range."
        return ToolResult(content=f"{head}\n{body}")


class CalendarFreeTimesTool(Tool):
    name = "calendar_free_times"
    category = "calendar"
    max_per_turn = 4
    timeout_seconds = 15.0
    max_content_chars = 8_000
    description = (
        "Find times when the user and other people on this Promptly are all free, e.g. 'when are Sam and I both free "
        "this weekend for 2 hours?'. Other people's calendars only say when they're not available — never what they're doing."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "people": {"type": "array", "items": {"type": "string"}, "description": "Usernames of the others (the user is always included)."},
            "start": {"type": "string", "description": "First day, YYYY-MM-DD (default today)."},
            "end": {"type": "string", "description": "Last day, YYYY-MM-DD (default 6 days after start; at most 14 days)."},
            "minutes": {"type": "integer", "description": "How long it needs, in minutes (default 60)."},
            "from_hour": {"type": "integer", "description": "Earliest start hour of day, 0-23 (default 8)."},
            "to_hour": {"type": "integer", "description": "Latest end hour of day, 1-24 (default 21)."},
        },
        "required": ["people"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.calendars import core, lookup, recur

        tz_name = core.user_tz(ctx.user)
        tz = recur.zone(tz_name)
        now = datetime.now(tz)
        try:
            first = date.fromisoformat(str(args.get("start"))[:10]) if args.get("start") else now.date()
            last = date.fromisoformat(str(args.get("end"))[:10]) if args.get("end") else first + timedelta(days=6)
        except ValueError as e:
            raise ToolError("Dates must be YYYY-MM-DD.") from e
        if last < first or (last - first).days > 13:
            raise ToolError("Pick a range of up to two weeks.")
        minutes = max(15, min(int(args.get("minutes") or 60), 24 * 60))
        lo, hi = int(args.get("from_hour") if args.get("from_hour") is not None else 8), int(args.get("to_hour") or 21)
        if not (0 <= lo < hi <= 24):
            raise ToolError("Hours must be 0-24, earliest before latest.")
        others = await _resolve_people(ctx, [str(x) for x in (args.get("people") or [])][:10])
        ids = [ctx.user.id, *others]
        start = datetime.combine(first, datetime.min.time(), tz).astimezone(UTC)
        end = datetime.combine(last + timedelta(days=1), datetime.min.time(), tz).astimezone(UTC)
        busy = await lookup.busy(ctx.db, ids, start, end)
        spans = sorted(
            (datetime.fromisoformat(a.replace("Z", "+00:00")), datetime.fromisoformat(b.replace("Z", "+00:00")))
            for ss in busy.values() for a, b in ss
        )
        need = timedelta(minutes=minutes)
        free: list[str] = []
        day = first
        while day <= last and len(free) < 40:
            w0 = datetime.combine(day, datetime.min.time(), tz) + timedelta(hours=lo)
            w1 = datetime.combine(day, datetime.min.time(), tz) + timedelta(hours=hi)
            cur = max(w0, now) if day == now.date() else w0
            # Round a "from now" start up to the next quarter hour.
            if cur.minute % 15 or cur.second:
                cur = cur.replace(second=0, microsecond=0) + timedelta(minutes=15 - cur.minute % 15)
            for s0, e0 in spans:
                s0, e0 = s0.astimezone(tz), e0.astimezone(tz)
                if e0 <= cur or s0 >= w1:
                    continue
                if s0 - cur >= need:
                    free.append(f"- {cur:%a %d %b} {cur:%H:%M}–{min(s0, w1):%H:%M}")
                cur = max(cur, e0)
            if w1 - cur >= need:
                free.append(f"- {cur:%a %d %b} {cur:%H:%M}–{w1:%H:%M}")
            day += timedelta(days=1)
        users = await core.users_map(ctx.db, set(ids))
        who = ", ".join(users.get(str(i), {}).get("username", "?") for i in ids)
        head = (
            f"Times are in {tz_name}. Free for {minutes} min or more, {lo:02d}:00–{hi:02d}:00, "
            f"{first} to {last}, for everyone of: {who} (all-day events don't count as busy):"
        )
        return ToolResult(content=head + "\n" + ("\n".join(free) or "(no time when everyone is free)"))


class CalendarAddEventTool(Tool):
    name = "calendar_add_event"
    category = "calendar"
    max_per_turn = 6
    timeout_seconds = 20.0
    description = (
        "Add an event to the user's calendar, optionally on a shared calendar and/or inviting people on this "
        "Promptly (they get a notification and can answer). Times are the user's local time unless they say "
        "otherwise. Only add what the user asked for."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "start": {"type": "string", "description": "Local start, YYYY-MM-DDTHH:MM (or YYYY-MM-DD for all-day)."},
            "end": {"type": "string", "description": "Local end (default an hour after start; for all-day, the last day)."},
            "all_day": {"type": "boolean"},
            "location": {"type": "string"},
            "description": {"type": "string"},
            "calendar": {"type": "string", "description": "A shared calendar's name (default: the user's own)."},
            "guests": {"type": "array", "items": {"type": "string"}, "description": "Usernames to invite."},
            "repeat": _REPEAT_SCHEMA,
            "reminders": {"type": "array", "items": {"type": "integer"}, "description": "Minutes before (default [10]; all-day default none)."},
            "label": _LABEL_SCHEMA,
        },
        "required": ["title", "start"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from fastapi import HTTPException

        from app.calendars import core, service

        _untrusted(ctx)
        label = await _label(ctx, args.get("label"))
        f = service.EventFields(
            title=str(args.get("title") or ""),
            start=str(args.get("start") or ""),
            end=(str(args["end"]) if args.get("end") else None),
            all_day=bool(args.get("all_day")),
            location=str(args.get("location") or ""),
            description=str(args.get("description") or ""),
            calendar_id=await _calendar_id(ctx, args.get("calendar")),
            guests=await _resolve_people(ctx, list(args.get("guests") or [])),
            repeat=_repeat(args.get("repeat")),
            repeat_set=True,
            reminders=args.get("reminders"),
        )
        try:
            ev = await service.create_event(ctx.db, ctx.user, f)
            if label:
                from app.calendars import labels

                await labels.set_on_event(ctx.db, ctx.user, ev.id, label.id)
            await ctx.db.commit()
        except HTTPException as e:
            raise ToolError(str(e.detail)) from e
        when = _when(ev, core.user_tz(ctx.user))
        guests = f" Invited: {', '.join(str(a) for a in args.get('guests') or [])}." if f.guests else ""
        return ToolResult(
            content=f"Added “{ev.title}” — {when}.{guests} (event_id {ev.id})",
            meta={"url": f"/calendar?event={ev.id}", "summary": f"Added {ev.title}"},
        )


class CalendarChangeEventTool(Tool):
    name = "calendar_change_event"
    category = "calendar"
    max_per_turn = 6
    timeout_seconds = 20.0
    description = (
        "Change an event from calendar_events: move or edit it, invite or uninvite people, delete it, or answer "
        "an invitation (going / maybe / declined). For a repeating event, scope says whether it's just this "
        "occurrence, this and following, or all. Only do what the user asked."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "event_id": {"type": "string"},
            "occurrence": {"type": "string", "description": "The occurrence from calendar_events (repeating events)."},
            "scope": {"type": "string", "enum": ["this", "following", "all"], "description": "Repeating events only (default this)."},
            "action": {"type": "string", "enum": ["update", "delete", "answer"]},
            "answer": {"type": "string", "enum": ["going", "maybe", "declined"]},
            "title": {"type": "string"},
            "start": {"type": "string", "description": "New local start, YYYY-MM-DDTHH:MM (or a date for all-day)."},
            "end": {"type": "string"},
            "all_day": {"type": "boolean"},
            "location": {"type": "string"},
            "description": {"type": "string"},
            "add_guests": {"type": "array", "items": {"type": "string"}},
            "remove_guests": {"type": "array", "items": {"type": "string"}},
            "repeat": _REPEAT_SCHEMA,
            "stop_repeating": {"type": "boolean"},
            "label": {**_LABEL_SCHEMA, "description": _LABEL_SCHEMA["description"] + " Use 'none' to take it off."},
        },
        "required": ["event_id", "action"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from fastapi import HTTPException
        from sqlalchemy import select

        from app.calendars import core, service
        from app.calendars.models import CalAttendee

        _untrusted(ctx)
        try:
            eid = uuid.UUID(str(args.get("event_id")))
        except ValueError as e:
            raise ToolError("event_id isn't an id — use calendar_events.") from e
        action = args.get("action")
        occurrence = args.get("occurrence")
        try:
            ev, _m, _a = await core.load_event(ctx.db, eid, ctx.user)
            scope = (args.get("scope") or "this") if ev.repeat else "all"
            if action == "answer":
                await service.rsvp(ctx.db, ctx.user, eid, str(args.get("answer") or ""))
                await ctx.db.commit()
                return ToolResult(content=f"Answered “{args.get('answer')}” to {ev.title}.")
            if action == "delete":
                title = ev.title
                await service.delete_event(ctx.db, ctx.user, eid, scope=scope, occurrence=occurrence)
                await ctx.db.commit()
                return ToolResult(content=f"Deleted {title}" + ("" if scope == "all" else f" ({scope})") + ".")
            if action != "update":
                raise ToolError("action must be update, delete or answer.")
            has_label = isinstance(args.get("label"), str) and args["label"].strip() != ""
            label = None
            if has_label and args["label"].strip().lower() != "none":
                label = await _label(ctx, args["label"])
            changes = {k for k in _CHANGE_KEYS if args.get(k) not in (None, "", [])}
            if has_label and not changes:
                # Only your own label: anyone who can see the event can do this.
                from app.calendars import labels

                await labels.set_on_event(ctx.db, ctx.user, ev.id, label.id if label else None)
                await ctx.db.commit()
                return ToolResult(content=(f"Labelled “{ev.title}” {label.name}." if label else f"Took the label off “{ev.title}”."))
            f = service.EventFields(
                title=args.get("title"), start=args.get("start"), end=args.get("end"),
                all_day=args.get("all_day"), location=args.get("location"), description=args.get("description"),
            )
            if args.get("stop_repeating"):
                f.repeat, f.repeat_set = None, True
            elif args.get("repeat"):
                f.repeat, f.repeat_set = _repeat(args.get("repeat")), True
            if args.get("add_guests") or args.get("remove_guests"):
                have = list((await ctx.db.execute(select(CalAttendee.user_id).where(CalAttendee.event_id == eid))).scalars())
                add = await _resolve_people(ctx, list(args.get("add_guests") or []))
                drop = set(await _resolve_people(ctx, list(args.get("remove_guests") or [])))
                f.guests = [g for g in [*have, *add] if g not in drop]
            ev = await service.update_event(ctx.db, ctx.user, eid, f, scope=scope, occurrence=occurrence)
            if has_label:
                from app.calendars import labels

                await labels.set_on_event(ctx.db, ctx.user, ev.id, label.id if label else None)
            await ctx.db.commit()
        except HTTPException as e:
            raise ToolError(str(e.detail)) from e
        return ToolResult(
            content=f"Updated “{ev.title}” — {_when(ev, core.user_tz(ctx.user))}. (event_id {ev.id})",
            meta={"url": f"/calendar?event={ev.id}", "summary": f"Updated {ev.title}"},
        )


def _when(ev, tz_name: str) -> str:  # noqa: ANN001
    from app.calendars.notify import when_text

    return when_text(ev.start_at, ev.end_at, ev.all_day, tz_name)

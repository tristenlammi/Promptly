"""One assistant across the apps: the day/week at a glance, who someone is,
a search over the everyday apps, and Rooms.

* ``my_day`` — a date range across apps: events, tasks due (and overdue),
  bills due from Budget, planned workouts and meals, shifts, birthdays,
  trips under way or coming up, and (for today) habits left and unread rooms.
  Each app's file id comes back so ``use_item`` can dig in.
* ``find_person`` — someone by name or label ("Sam", "my wife"): their
  contact card, their account on this Promptly, events coming up with them
  and the rooms you share.
* ``search_apps`` — events, contacts, tasks, trips and recipes matching words.
* ``read_room`` — your rooms with unread counts; a room's recent messages
  only where Rooms already lets the AI read it (a room admin's "Promptly can
  read this room", or every member of a DM saying yes). Messages are other
  people's words, so the chat router treats this tool as outside content.
* ``post_to_room`` — send a message as the user. Like ``use_item`` it
  refuses on a turn that read outside content.

Everything is the user's own view: their own app files, events they can
see, rooms they're in. Category ``apps`` rides on the Tools toggle for
everyone; ``rooms`` for people in a space or conversation.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("promptly.tools.crossapp")

UTC = timezone.utc
_MAX_DAYS = 31


def _day(raw: Any, default: date) -> date:
    if not raw:
        return default
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError as e:
        raise ToolError("Dates must be YYYY-MM-DD.") from e


def _md(raw: str | None) -> tuple[int, int] | None:
    """(month, day) of a contact date: ``YYYY-MM-DD`` or ``--MM-DD``."""
    s = str(raw or "")
    if len(s) < 5:
        return None
    try:
        m, d = int(s[-5:-3]), int(s[-2:])
    except ValueError:
        return None
    return (m, d) if 1 <= m <= 12 and 1 <= d <= 31 else None


# ================================================================== my_day


async def _primary(ctx: ToolContext, kind: str):  # noqa: ANN202
    from app.items import service

    try:
        found = await service.primary_file(ctx.db, ctx.user, kind)
        if found is not None:
            await service.upgrade(ctx.db, found[1])
        return found
    except Exception:  # noqa: BLE001 — one app mustn't sink the overview
        logger.exception("my_day: reading %s failed", kind)
        return None


class MyDayTool(Tool):
    name = "my_day"
    category = "apps"
    max_per_turn = 3
    timeout_seconds = 25.0
    max_content_chars = 14_000
    description = (
        "The user's day or week across all their apps in one call: calendar events, tasks due (and overdue), "
        "bills due, planned workouts and meals, work shifts, birthdays, trips, and for today habits left and "
        "unread rooms. Use for 'what's my day/week look like', 'what's on tomorrow', 'am I busy Friday'. "
        "Returns each app's file id for use_item."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "start": {"type": "string", "description": "First day, YYYY-MM-DD (default today)."},
            "end": {"type": "string", "description": "Last day, YYYY-MM-DD (default = start; at most 31 days)."},
        },
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.today import core as today_core

        tz = today_core.zone_of(ctx.user)
        now = datetime.now(UTC).astimezone(tz)
        today = now.date()
        first = _day(args.get("start"), today)
        last = _day(args.get("end"), first)
        if last < first or (last - first).days >= _MAX_DAYS:
            raise ToolError(f"Pick a range of up to {_MAX_DAYS} days.")
        days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
        per_day: dict[date, list[tuple[str, str]]] = {d: [] for d in days}  # (sort key, line)
        notes: list[str] = []
        files: list[str] = []

        def put(d: date, key: str, line: str) -> None:
            if d in per_day:
                per_day[d].append((key, line))

        # ---- calendar
        try:
            from app.calendars import core as cal

            start = today_core.day_bounds(first, tz)[0]
            end = today_core.day_bounds(last, tz)[1]
            occ = await cal.occurrences_out(ctx.db, ctx.user, await cal.visible_events(ctx.db, ctx.user, start, end), start, end)
            for o in occ:
                if o.get("busy_only") or o.get("my_status") == "declined":
                    continue
                title = o.get("title") or "Untitled event"
                where = f" @ {o['location']}" if o.get("location") else ""
                if o["all_day"]:
                    s, e = date.fromisoformat(o["start"][:10]), date.fromisoformat(o["end"][:10])
                    d = max(s, first)
                    while d <= min(e, last):
                        put(d, "00:00", f"(all day) {title}{where} [event]")
                        d += timedelta(days=1)
                else:
                    s = datetime.fromisoformat(o["start"].replace("Z", "+00:00")).astimezone(tz)
                    e = datetime.fromisoformat(o["end"].replace("Z", "+00:00")).astimezone(tz)
                    put(s.date(), s.strftime("%H:%M"), f"{s:%H:%M}–{e:%H:%M} {title}{where} [event]")
        except Exception:  # noqa: BLE001
            logger.exception("my_day: calendar failed")
            notes.append("Calendar couldn't be read just now.")

        # ---- tasks
        found = await _primary(ctx, "tasks")
        if found:
            row, doc = found
            files.append(f"Tasks {row.id}")
            data = doc.data or {}
            overdue = 0
            for t in data.get("tasks", []):
                if t.get("done") or not t.get("due"):
                    continue
                try:
                    due = date.fromisoformat(t["due"][:10])
                except ValueError:
                    continue
                if due < today and first <= today <= last:
                    overdue += 1
                    if overdue <= 8:
                        put(today, "00:01", f"task OVERDUE (was due {due:%a %d %b}): {t.get('title')}")
                elif first <= due <= last:
                    at = t.get("time") or ""
                    put(due, at or "23:58", f"{at + ' ' if at else ''}task: {t.get('title')}" + (" (!)" if t.get("priority", 0) >= 2 else ""))
            if overdue > 8:
                notes.append(f"{overdue} overdue tasks in all (8 shown).")

        # ---- habits (today only)
        if first <= today <= last:
            found = await _primary(ctx, "habits")
            if found:
                files.append(f"Habits {found[0].id}")
                try:
                    h = today_core.habits_section(found[0].id, found[1].data or {}, now)
                except Exception:  # noqa: BLE001
                    h = None
                if h:
                    left = [x["name"] for x in h["habits"] if not x["done"]]
                    put(today, "23:59", f"habits left today: {', '.join(left)}" if left else "habits: all done today")

        # ---- workouts
        found = await _primary(ctx, "workout")
        if found:
            files.append(f"Workout {found[0].id}")
            for s in (found[1].data or {}).get("planned", []):
                if s.get("status") not in ("planned", "done"):
                    continue
                try:
                    d = date.fromisoformat(str(s.get("date"))[:10])
                except ValueError:
                    continue
                at = s.get("time") or ""
                put(d, at or "23:57", f"{at + ' ' if at else ''}workout: {s.get('name') or 'Workout'}" + (" (done)" if s.get("status") == "done" else ""))

        # ---- meals
        found = await _primary(ctx, "mealplan")
        if found:
            files.append(f"Meal planner {found[0].id}")
            data = found[1].data or {}
            recipes = {r.get("id"): r for r in data.get("recipes", [])}
            for e in data.get("plan", []):
                try:
                    d = date.fromisoformat(str(e.get("date"))[:10])
                except ValueError:
                    continue
                r = recipes.get(e.get("recipe_id") or "")
                title = e.get("title") or (r.get("title") if r else "") or "Meal"
                slot = e.get("slot", "dinner")
                put(d, f"zz{today_core.SLOT_ORDER.get(slot, 9)}", f"{slot}: {title}")

        # ---- bills
        found = await _primary(ctx, "budget")
        if found:
            from app.items.kinds.budget import logic as B
            from app.items.kinds.budget import subscriptions as S

            files.append(f"Budget {found[0].id}")
            data = found[1].data or {}
            cur = (data.get("settings") or {}).get("currency", "AUD")
            total = 0
            for s in data.get("subscriptions", []):
                if not S.is_live(s) or not s.get("next_due"):
                    continue
                try:
                    d = B.parse_day(s["next_due"])
                except ValueError:
                    continue
                guard = 0
                while d <= last and guard < 400:
                    if d >= first:
                        amt = int(s.get("amount_cents") or 0)
                        total += abs(amt)
                        put(d, "zz8", f"bill due: {s.get('name')} {'~' if s.get('variable') else ''}{B.fmt(abs(amt), cur)}")
                    d = B.next_due_from(d, s.get("cadence", "monthly"))
                    guard += 1
            if total:
                notes.append(f"Bills due in this range: {B.fmt(total, cur)} in all.")

        # ---- shifts
        if last >= today:
            try:
                from app.workspaces.router import _my_shifts

                for sh in await _my_shifts(ctx.db, ctx.user, days=(last - today).days + 1):
                    d = date.fromisoformat(sh.date)
                    span = f"{sh.start}–{sh.end}" if sh.start and sh.end else "shift"
                    put(d, sh.start or "00:02", f"{span} shift: {sh.roster_title} ({sh.workspace_title})")
            except Exception:  # noqa: BLE001
                logger.exception("my_day: shifts failed")

        # ---- birthdays and dates from Contacts
        for row, doc in await _contacts(ctx):
            from app.items.kinds.contacts.logic import display_name

            files.append(f"Contacts {row.id}")
            for c in (doc.data or {}).get("contacts", []):
                marks = [("birthday", c.get("birthday"))] + [(x.get("label") or "date", x.get("date")) for x in c.get("dates", [])]
                for label, raw in marks:
                    md = _md(raw)
                    if md is None:
                        continue
                    for d in days:
                        if (d.month, d.day) == md:
                            put(d, "zz0", f"{label}: {display_name(c)}")

        # ---- trips
        found = await _primary(ctx, "trip")
        if found:
            files.append(f"Trips {found[0].id}")
            horizon = last + timedelta(days=60)
            for t in (found[1].data or {}).get("trips", []):
                s, e = t.get("start"), t.get("end") or t.get("start")
                if not s:
                    continue
                try:
                    sd, ed = date.fromisoformat(s[:10]), date.fromisoformat(e[:10])
                except ValueError:
                    continue
                if ed < first or sd > horizon:
                    continue
                when = "under way" if sd <= today <= ed else (f"in {(sd - today).days} days" if sd > today else "")
                notes.append(f"Trip: {t.get('title') or 'Trip'} {sd:%a %d %b}–{ed:%a %d %b} {when} (trip id {t.get('id')}).".replace("  ", " "))

        # ---- rooms (today only: counts, never text)
        if first <= today <= last:
            try:
                r = await today_core.rooms_unread(ctx.db, ctx.user, limit=5)
            except Exception:  # noqa: BLE001
                r = None
            if r and r.get("total"):
                names = ", ".join(f"{x['name']} ({x['unread']})" for x in r["rooms"])
                notes.append(f"Unread in Rooms: {r['total']} — {names}.")

        lines = [f"Today is {today:%A %Y-%m-%d}; times in {tz}. {first:%a %d %b} to {last:%a %d %b}:"]
        for d in days:
            items = sorted(per_day[d])
            lines.append(f"\n{d:%A %d %b}" + (" (today)" if d == today else ""))
            lines.extend([f"- {line}" for _k, line in items] or ["- nothing planned"])
        if notes:
            lines.append("")
            lines.extend(notes)
        lines.append("\nApp files (for use_item): " + (", ".join(dict.fromkeys(files)) if files else "none yet"))
        return ToolResult(content="\n".join(lines))


async def _contacts(ctx: ToolContext):  # noqa: ANN202
    from app.items import service

    try:
        return await service.list_items(ctx.db, ctx.user, "contacts", limit=1, archives=False)
    except Exception:  # noqa: BLE001
        logger.exception("reading contacts failed")
        return []


# ================================================================== find_person


class FindPersonTool(Tool):
    name = "find_person"
    category = "apps"
    max_per_turn = 4
    timeout_seconds = 20.0
    max_content_chars = 8_000
    description = (
        "Look someone up by name, nickname or what they are to the user ('Sam', 'my wife', 'mum'): their "
        "contact details, their username on this Promptly (for invites and messages), birthday, events coming "
        "up with them and rooms you share."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.auth.models import User
        from app.people.directory import Person, complete, directory
        from app.people.router import _events, _hits, _rooms

        raw = str(args.get("name") or "").strip()
        needle = raw.lower().removeprefix("my ").lstrip("@").strip()
        if len(needle) < 2:
            raise ToolError("Give at least two letters of a name.")
        people = [p for p in await directory(ctx.db, ctx.user) if _hits(p, needle)]
        people.sort(key=lambda p: (needle not in {(p.label or "").lower(), p.name.lower()}, p.user is None, p.name.lower()))
        seen = {p.user.id for p in people if p.user is not None}
        esc = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        accounts = (
            await ctx.db.execute(
                select(User)
                .where(User.disabled.is_(False), User.id != ctx.user.id, User.username.ilike(f"%{esc}%", escape="\\"))
                .order_by(func.length(User.username))
                .limit(5)
            )
        ).scalars().all()
        people += [Person(user=u) for u in accounts if u.id not in seen]
        if not people:
            return ToolResult(content=f"No one called “{raw}” in the user's contacts, photos or on this Promptly.")
        detailed = len(people) <= 3
        out: list[str] = []
        for p in people[:8]:
            if detailed:
                p = await complete(ctx.db, ctx.user, p)
            head = p.name + (f" — {p.label}" if p.label else "")
            head += f" — on Promptly as @{p.user.username}" if p.user is not None else " — not on this Promptly"
            bits = [head]
            c = p.contact
            if c is not None:
                for key in ("company", "title", "nickname"):
                    if c.get(key):
                        bits.append(f"{key}: {c[key]}")
                phones = [x.get("value") for x in c.get("phones", []) if x.get("value")]
                emails = [x.get("value") for x in c.get("emails", []) if x.get("value")]
                if phones:
                    bits.append("phone: " + ", ".join(phones[:3]))
                if emails:
                    bits.append("email: " + ", ".join(emails[:3]))
                if c.get("birthday"):
                    bits.append(f"birthday: {c['birthday']}")
                for a in c.get("addresses", [])[:1]:
                    addr = ", ".join(a.get(k) for k in ("street", "city", "region", "country") if a.get(k))
                    if addr:
                        bits.append(f"address: {addr}")
                bits.append(f"contact {c.get('id')} in Contacts file {p.file_id}")
            if detailed and p.user is not None and p.user.id != ctx.user.id:
                try:
                    evs = await _events(ctx.db, ctx.user, p.user)
                    if evs:
                        bits.append("coming up together: " + "; ".join(f"{e['title']} ({str(e['start'])[:16].replace('T', ' ')})" for e in evs[:4]))
                    dm, rooms = await _rooms(ctx.db, ctx.user, p.user)
                    if dm or rooms:
                        bits.append("rooms: " + ", ".join((["your DM"] if dm else []) + [r["name"] for r in rooms[:6]]))
                except Exception:  # noqa: BLE001
                    logger.exception("find_person: extras failed")
            out.append("- " + " · ".join(bits))
        more = f"\n…and {len(people) - 8} more — be more specific." if len(people) > 8 else ""
        return ToolResult(content="\n".join(out) + more)


# ================================================================== search_apps


class SearchAppsTool(Tool):
    name = "search_apps"
    category = "apps"
    max_per_turn = 4
    timeout_seconds = 20.0
    max_content_chars = 8_000
    description = (
        "Search the user's everyday apps by words: calendar events, contacts, tasks, trips and recipes. Use when "
        "you don't know which app holds something ('when's the dentist?', 'the lasagne recipe'). Documents are "
        "search_my_files; photos are search_photos."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.items import service
        from app.today.router import search

        q = str(args.get("query") or "").strip()[:200]
        term = q.lower()
        if len(term) < 2:
            raise ToolError("Search for at least two letters.")
        # The user's own app files first; the shared everyday search (events,
        # contacts, tasks — what Ctrl+K shows) last, as it may end the
        # transaction on a soft failure.
        found: list[str] = []
        for row, doc in await service.list_items(ctx.db, ctx.user, "trip", limit=3, archives=False):
            for t in (doc.data or {}).get("trips", []):
                hay = [t.get("title") or ""] + [d.get("name") or "" for d in t.get("destinations", [])]
                if any(term in h.lower() for h in hay):
                    found.append(f"- trip: {t.get('title') or 'Trip'} {t.get('start') or ''}–{t.get('end') or ''} (Trips file {row.id}, trip {t.get('id')})")
        for row, doc in await service.list_items(ctx.db, ctx.user, "mealplan", limit=3, archives=False):
            hits = [
                r for r in (doc.data or {}).get("recipes", [])
                if term in (r.get("title") or "").lower() or any(term in str(x).lower() for x in r.get("tags", []))
            ]
            found += [f"- recipe: {r.get('title')} (Meal planner file {row.id}, recipe {r.get('id')})" for r in hits[:6]]
        got = await search(q=q, limit=6, db=ctx.db, user=ctx.user)
        lines: list[str] = []
        for e in got.get("events", []):
            lines.append(f"- event: {e['title']} — {str(e['start'])[:16].replace('T', ' ')}" + (f" @ {e['location']}" if e.get("location") else "") + f" (event_id {e['event_id']})")
        for c in got.get("contacts", []):
            lines.append(f"- contact: {c['name']}" + (f" — {c['detail']}" if c.get("detail") else ""))
        for t in got.get("tasks", []):
            lines.append(f"- task: {t['title']}" + (" (done)" if t.get("done") else "") + (f" due {t['due']}" if t.get("due") else "") + f" [{t['list']}]")
        lines += found
        if not lines:
            return ToolResult(content=f"Nothing in events, contacts, tasks, trips or recipes matches “{q}”.")
        return ToolResult(content=f"Matches for “{q}”:\n" + "\n".join(lines))


# ================================================================== rooms


async def has_rooms(db, user_id: uuid.UUID) -> bool:  # noqa: ANN001
    from app.rooms.models import RoomMember, RoomSpaceMember

    if (await db.execute(select(RoomSpaceMember.space_id).where(RoomSpaceMember.user_id == user_id).limit(1))).first():
        return True
    return (await db.execute(select(RoomMember.room_id).where(RoomMember.user_id == user_id).limit(1))).first() is not None


async def _labelled_rooms(ctx: ToolContext) -> list[tuple[Any, str, str | None, list[str]]]:
    """Every room the user can see: (room, label, space name, other people's usernames)."""
    from app.auth.models import User
    from app.rooms.core import visible_room_ids
    from app.rooms.models import Room, RoomMember, RoomSpace

    ids = await visible_room_ids(ctx.db, ctx.user.id)
    if not ids:
        return []
    rows = (
        await ctx.db.execute(
            select(Room, RoomSpace.name).outerjoin(RoomSpace, RoomSpace.id == Room.space_id).where(Room.id.in_(ids))
            .order_by(Room.last_message_at.desc().nulls_last())
        )
    ).all()
    dm_ids = [r.id for r, _ in rows if r.space_id is None]
    others: dict[uuid.UUID, list[str]] = {}
    if dm_ids:
        for rid, uname in (
            await ctx.db.execute(
                select(RoomMember.room_id, User.username).join(User, User.id == RoomMember.user_id)
                .where(RoomMember.room_id.in_(dm_ids), RoomMember.user_id != ctx.user.id)
            )
        ).all():
            others.setdefault(rid, []).append(uname)
    out = []
    for room, space in rows:
        if room.space_id is not None:
            out.append((room, f"#{room.name} in {space}", space, []))
        else:
            people = sorted(others.get(room.id, []))
            label = room.name or ", ".join(people) or "Direct message"
            out.append((room, f"{'DM' if room.kind == 'dm' else 'group'} with {label}" if not room.name else room.name, None, people))
    return out


async def _find_room(ctx: ToolContext, ref: str):  # noqa: ANN202
    from app.rooms import core

    ref = ref.strip()
    try:
        rid = uuid.UUID(ref)
    except ValueError:
        rid = None
    if rid is not None:
        try:
            room, _sm = await core.load_room(ctx.db, rid, ctx.user)
        except Exception as e:  # noqa: BLE001 — a 404 for rooms you can't see
            raise ToolError("No room with that id — call read_room to list them.") from e
        return room
    want = ref.lower().lstrip("#@").strip()
    rooms = await _labelled_rooms(ctx)

    def keys(room, space, people) -> set[str]:  # noqa: ANN001
        k = {(room.name or "").lower()}
        if space:
            s = space.lower()
            k |= {f"{s}/{room.name.lower()}", f"{room.name.lower()} in {s}", f"{s} {room.name.lower()}"}
        k |= {p.lower() for p in people if room.kind == "dm"}
        return k - {""}

    hits = [r for r, _l, s, p in rooms if want in keys(r, s, p)]
    if not hits:
        # A space's name on its own: its first room.
        spaced = [(r, s) for r, _l, s, _p in rooms if s and s.lower() == want]
        if spaced:
            hits = [min((r for r, _s in spaced), key=lambda r: r.position)]
    if not hits:
        hits = [r for r, label, _s, _p in rooms if want and want in label.lower()]
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(label for _r, label, _s, _p in rooms[:15]) or "none"
    if not hits:
        raise ToolError(f"No room matches “{ref}”. Rooms: {names}")
    raise ToolError(f"Several rooms match “{ref}” — name the space too, or pass its id. Rooms: {names}")


class ReadRoomTool(Tool):
    name = "read_room"
    category = "rooms"
    max_per_turn = 4
    timeout_seconds = 15.0
    max_content_chars = 12_000
    description = (
        "Rooms (the team/family chat app). With no room: the user's rooms and DMs with unread counts and ids. "
        "With a room: its recent messages — only for rooms where everyone agreed Promptly may read them."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "room": {"type": "string", "description": "Room id, name ('general', 'Family/general'), or a username for a DM."},
            "limit": {"type": "integer", "description": "Messages to read (default 20, at most 50)."},
        },
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from app.auth.models import User
        from app.rooms.models import RoomMessage
        from app.rooms.promptly import can_read_history
        from app.rooms.core import rooms_out
        from app.today.core import zone_of

        ref = str(args.get("room") or "").strip()
        if not ref:
            rooms = await _labelled_rooms(ctx)
            if not rooms:
                return ToolResult(content="The user isn't in any rooms yet.")
            states = {d["id"]: d for d in await rooms_out(ctx.db, [r for r, *_ in rooms[:40]], ctx.user)}
            lines = []
            for room, label, _s, _p in rooms[:40]:
                st = states.get(str(room.id), {})
                if st.get("hidden"):
                    continue
                bits = [label]
                if st.get("unread"):
                    bits.append(f"{st['unread']} unread" + (f", {st['mentions']} mention you" if st.get("mentions") else ""))
                bits.append("Promptly can read it" if st.get("ai_context") else "private to its members")
                lines.append(f"- {' · '.join(bits)} (id {room.id})")
            return ToolResult(content="Rooms:\n" + "\n".join(lines))
        room = await _find_room(ctx, ref)
        label = next((lab for r, lab, _s, _p in await _labelled_rooms(ctx) if r.id == room.id), room.name or "the room")
        if not await can_read_history(ctx.db, room):
            how = "a room admin turns on “Promptly can read this room”" if room.space_id else "everyone in it turns on “Promptly can read this conversation”"
            return ToolResult(content=f"{label}: its messages are private to its members — you can't read them unless {how}. You can still post there if asked.")
        limit = max(1, min(int(args.get("limit") or 20), 50))
        rows = list(
            (
                await ctx.db.execute(
                    select(RoomMessage)
                    .where(RoomMessage.room_id == room.id, RoomMessage.deleted_at.is_(None))
                    .order_by(RoomMessage.seq.desc())
                    .limit(limit)
                )
            ).scalars()
        )[::-1]
        names = {
            u.id: u.username
            for u in (await ctx.db.execute(select(User).where(User.id.in_({r.author_id for r in rows if r.author_id})))).scalars()
        }
        tz = zone_of(ctx.user)
        out = []
        for m in rows:
            who = "Promptly" if m.kind == "promptly" else ("system" if m.kind == "system" else names.get(m.author_id, "someone"))
            if m.author_id == ctx.user.id:
                who += " (the user)"
            when = m.created_at.astimezone(tz).strftime("%a %d %b %H:%M") if m.created_at else ""
            out.append(f"[{when}] {who}: {(m.body or '').strip()[:1000]}")
        return ToolResult(content=f"Last {len(out)} messages in {label}:\n" + ("\n".join(out) or "(no messages)"), meta={"url": f"/rooms/r/{room.id}"})


class PostToRoomTool(Tool):
    name = "post_to_room"
    category = "rooms"
    max_per_turn = 3
    timeout_seconds = 20.0
    description = (
        "Send a message in Rooms as the user — in a room ('general', 'Family/general') or as a direct message to "
        "a username. It's sent straight away and everyone there sees it, so only send what the user asked to, "
        "in their words."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "room": {"type": "string", "description": "Room id or name."},
            "to": {"type": "string", "description": "Or: a username, for a direct message."},
            "message": {"type": "string"},
        },
        "required": ["message"],
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        from fastapi import HTTPException

        from app.auth.models import User
        from app.rooms import router as rooms_router

        if ctx.turn and ctx.turn.get("untrusted"):
            raise ToolError("Not posting on a turn that read outside content — ask the user to confirm in a new message.")
        body = str(args.get("message") or "").strip()
        if not body:
            raise ToolError("The message is empty.")
        to = str(args.get("to") or "").strip().lstrip("@")
        ref = str(args.get("room") or "").strip()
        try:
            if to:
                n = to.lower()
                rows = (
                    await ctx.db.execute(
                        select(User).where(User.disabled.is_(False), or_(func.lower(User.username) == n, func.lower(User.email) == n))
                    )
                ).scalars().all()
                if len(rows) != 1 or rows[0].id == ctx.user.id:
                    raise ToolError(f"No one on this Promptly is called “{to}” — use find_person for their username.")
                dm = await rooms_router.open_dm(rooms_router.DmIn(user_ids=[rows[0].id]), db=ctx.db, user=ctx.user)
                room_id, label = uuid.UUID(dm["id"]), f"your DM with @{rows[0].username}"
            elif ref:
                room = await _find_room(ctx, ref)
                room_id = room.id
                label = next((lab for r, lab, _s, _p in await _labelled_rooms(ctx) if r.id == room.id), room.name or "the room")
            else:
                raise ToolError("Say which room, or who to message.")
            msg = await rooms_router.send(room_id, rooms_router.MessageIn(body=body[:8000]), db=ctx.db, user=ctx.user)
        except HTTPException as e:
            raise ToolError(str(e.detail)) from e
        return ToolResult(
            content=f"Sent in {label}.",
            meta={"url": f"/rooms/r/{room_id}", "room_id": str(room_id), "message_id": msg["id"]},
        )

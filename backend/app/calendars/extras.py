"""What else shows on your calendar: tasks with a due date (from your Tasks
app), birthdays / anniversaries (from Contacts, with the person's face
from Photos when they're linked), planned workouts, the meal plan, bills
due (Budget), trips, and public holidays for a country you pick. Read-only here — ticking a task off goes
through the Tasks app's own action, so both stay one source of truth."""
from __future__ import annotations

import calendar as pycal
import uuid
from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

MAX_TASKS = 500


def _days(start: date, end: date):  # noqa: ANN202
    d = start
    while d < end:
        yield d
        d += timedelta(days=1)


async def tasks_in(db: AsyncSession, user: User, start: date, end: date) -> list[dict]:
    """Open tasks due in [start, end) — a repeating task at its next due day."""
    from app.items import service

    out: list[dict] = []
    planned = await planned_tasks(db, user)
    for row, doc in await service.list_items(db, user, "tasks", archives=False):
        data = doc.data or {}
        lists = {lst.get("id"): lst for lst in data.get("lists", [])}
        for t in data.get("tasks", []):
            due = t.get("due")
            if t.get("done") or not due or not (start.isoformat() <= due < end.isoformat()):
                continue
            lst = lists.get(t.get("list_id")) or {}
            out.append(
                {
                    "file_id": str(row.id),
                    "task_id": t["id"],
                    "title": t.get("title", ""),
                    "due": due,
                    "time": t.get("time"),
                    "list": lst.get("name") or "Inbox",
                    "color": lst.get("color") or "#DB4C3F",
                    "priority": t.get("priority", 0),
                    "repeats": bool(t.get("repeat")),
                    # Planned into a time slot: that event (start, end).
                    "planned": planned.get((str(row.id), t["id"])),
                }
            )
            if len(out) >= MAX_TASKS:
                return out
    out.sort(key=lambda x: (x["due"], x["time"] or "99:99"))
    return out


def _on(md: str, year: int) -> date | None:
    """``MM-DD`` in ``year`` (29 Feb → 28 Feb in a common year)."""
    try:
        m, d = (int(x) for x in md.split("-"))
        return date(year, m, min(d, pycal.monthrange(year, m)[1]))
    except ValueError:
        return None


def _name(c: dict) -> str:
    from app.items.kinds.contacts.logic import display_name

    return display_name(c) or "Someone"


async def _faces(db: AsyncSession, user: User, file_ids: list[uuid.UUID]) -> dict[tuple[str, str], dict]:
    """(contact file, contact id) → the linked person in Photos (id + face)."""
    if not file_ids:
        return {}
    from app.photos.people_router import _crop

    rows = (
        await db.execute(
            text(
                "SELECT p.id, p.contact_file_id, p.contact_id, COALESCE(p.cover_id, "
                "(SELECT f.id FROM photo_faces f WHERE f.person_id = p.id ORDER BY f.size_px * f.score DESC LIMIT 1)) AS cover "
                "FROM photo_people p WHERE p.user_id = :u AND p.contact_file_id = ANY(:files) AND p.contact_id IS NOT NULL"
            ),
            {"u": user.id, "files": file_ids},
        )
    ).all()
    return {(str(r.contact_file_id), r.contact_id): {"person_id": str(r.id), "face": _crop(r.cover, user)} for r in rows}


async def birthdays_in(db: AsyncSession, user: User, start: date, end: date) -> list[dict]:
    """Birthdays and anniversaries falling in [start, end)."""
    from app.items import service

    files = await service.list_items(db, user, "contacts", archives=False)
    faces = await _faces(db, user, [row.id for row, _ in files])
    years = range(start.year, end.year + 1)
    out: list[dict] = []
    for row, doc in files:
        for c in (doc.data or {}).get("contacts", []):
            name = _name(c)
            dates: list[tuple[str, str, str]] = []
            if c.get("birthday"):
                dates.append(("birthday", c["birthday"], ""))
            for d in c.get("dates", []):
                if d.get("kind") == "anniversary" and d.get("date"):
                    dates.append(("anniversary", d["date"], d.get("label") or ""))
            if not dates:
                continue
            link = faces.get((str(row.id), c["id"]))
            for kind, raw, label in dates:
                born = int(raw[:4]) if not raw.startswith("--") else None
                md = raw[5:] if born is not None else raw[2:]
                for y in years:
                    day = _on(md, y)
                    if day is None or not (start <= day < end):
                        continue
                    out.append(
                        {
                            "kind": kind,
                            "day": day.isoformat(),
                            "name": name,
                            "label": label,
                            # The age they turn (or years married), when the year's known.
                            "years": (y - born) if born and y > born else None,
                            "file_id": str(row.id),
                            "contact_id": c["id"],
                            "person_id": link["person_id"] if link else None,
                            "face": link["face"] if link else None,
                            "photo": None if link and link["face"] else c.get("photo"),
                            "color": c.get("color"),
                        }
                    )
    out.sort(key=lambda x: (x["day"], x["name"]))
    return out


# ------------------------------------------------------------------ more apps
#
# Each is a small, range-limited, read-only list; tapping one opens the app
# it came from. Only the person's own app file (not archives) is read.

MAX_EXTRA = 400
_SLOT_ORDER = {"breakfast": 0, "lunch": 1, "dinner": 2, "snack": 3}


def _local_today(user: User) -> date:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from .core import user_tz

    try:
        return datetime.now(ZoneInfo(user_tz(user))).date()
    except Exception:  # noqa: BLE001 — a bad saved zone: UTC
        return date.today()


def _in(day: str | None, start: date, end: date) -> bool:
    return bool(day) and start.isoformat() <= day[:10] < end.isoformat()


async def workouts_in(db: AsyncSession, user: User, start: date, end: date) -> list[dict]:
    """Planned training sessions in [start, end), and (from today on) the
    person's usual training days (``settings.training_days``) that have no
    session planned yet, with what the day is for ("Legs")."""
    from app.items import service

    out: list[dict] = []
    today = _local_today(user)
    for row, doc in await service.list_items(db, user, "workout", archives=False):
        data = doc.data or {}
        fid = str(row.id)
        planned_days: set[str] = set()
        for s in data.get("planned", []):
            day = s.get("date")
            if not _in(day, start, end) or s.get("status") == "skipped":
                continue
            planned_days.add(day)
            out.append({
                "kind": "session", "file_id": fid, "id": s.get("id"), "day": day, "time": s.get("time"),
                "name": s.get("name") or "Workout", "done": s.get("status") == "done",
                "exercises": len(s.get("exercises") or []),
            })
        settings = data.get("settings") or {}
        focus = settings.get("day_focus") or {}
        days = {d for d in settings.get("training_days") or [] if isinstance(d, int) and 0 <= d <= 6}
        if days:
            for d in _days(max(start, today), end):
                iso = d.isoformat()
                if d.weekday() in days and iso not in planned_days:
                    out.append({
                        "kind": "day", "file_id": fid, "id": None, "day": iso, "time": None,
                        "name": focus.get(str(d.weekday())) or "Training day", "done": False, "exercises": 0,
                    })
        if len(out) >= MAX_EXTRA:
            break
    out.sort(key=lambda x: (x["day"], x["time"] or "99:99"))
    return out[:MAX_EXTRA]


async def meals_in(db: AsyncSession, user: User, start: date, end: date) -> list[dict]:
    """What's on the meal plan each day in [start, end)."""
    from app.items import service

    out: list[dict] = []
    for row, doc in await service.list_items(db, user, "mealplan", archives=False):
        data = doc.data or {}
        recipes = {r.get("id"): r.get("title") for r in data.get("recipes", [])}
        for p in data.get("plan", []):
            if not _in(p.get("date"), start, end):
                continue
            title = (p.get("title") or recipes.get(p.get("recipe_id")) or "").strip()
            if not title and p.get("leftovers_of"):
                title = "Leftovers"
            out.append({
                "file_id": str(row.id), "id": p.get("id"), "day": p["date"], "slot": p.get("slot") or "dinner",
                "title": title or "Meal", "cooked": bool(p.get("cooked")),
            })
            if len(out) >= MAX_EXTRA:
                break
    out.sort(key=lambda x: (x["day"], _SLOT_ORDER.get(x["slot"], 9)))
    return out


async def bills_in(db: AsyncSession, user: User, start: date, end: date) -> list[dict]:
    """Bills and subscriptions (from Budget) falling due in [start, end):
    each live one's next due day, rolled on by its cadence."""
    from app.items import service
    from app.items.kinds.budget import logic, subscriptions

    out: list[dict] = []
    for row, doc in await service.list_items(db, user, "budget", archives=False):
        data = doc.data or {}
        cur = (data.get("settings") or {}).get("currency", "AUD")
        for s in data.get("subscriptions", []):
            if not s.get("next_due") or not subscriptions.is_live(s):
                continue
            cadence = s.get("cadence") or "monthly"
            try:
                d = logic.parse_day(s["next_due"])
            except ValueError:
                continue
            for _ in range(800):  # far behind the range: catch up (bounded)
                if d >= start:
                    break
                d = logic.next_due_from(d, cadence)
            n = 0
            while d < end and n < 60:
                out.append({
                    "file_id": str(row.id), "id": s.get("id"), "day": d.isoformat(), "name": s.get("name") or "Bill",
                    "kind": s.get("kind") or "subscription", "cadence": cadence,
                    "amount": ("about " if s.get("variable") else "") + logic.fmt(int(s.get("amount_cents") or 0), cur),
                })
                d = logic.next_due_from(d, cadence)
                n += 1
            if len(out) >= MAX_EXTRA:
                break
    out.sort(key=lambda x: (x["day"], x["name"]))
    return out[:MAX_EXTRA]


async def trips_in(db: AsyncSession, user: User, start: date, end: date) -> list[dict]:
    """Trips whose dates overlap [start, end): a bar from first to last day."""
    from app.items import service
    from app.items.kinds.trip.trips import title_of

    out: list[dict] = []
    for row, doc in await service.list_items(db, user, "trip", archives=False):
        data = doc.data or {}
        trips = data.get("trips")
        if not isinstance(trips, list):  # an old one-trip file
            trips = [{**data, "id": data.get("id") or "trip"}] if data.get("start") else []
        for t in trips:
            s = t.get("start")
            e = t.get("end") or s
            if not s or e < s or e < start.isoformat() or s >= end.isoformat():
                continue
            out.append({
                "file_id": str(row.id), "trip_id": t.get("id") or "trip", "title": title_of(t), "emoji": t.get("emoji") or "✈️",
                "color": t.get("color") or "#2C9CC8", "start": s, "end": e, "status": t.get("status") or "planning",
            })
    out.sort(key=lambda x: (x["start"], x["title"]))
    return out[:100]


# ------------------------------------------------------------------ holidays


def _country_name(module: str) -> str:
    small = {"and", "of", "the", "da", "du"}
    return " ".join(w if i and w in small else w.capitalize() for i, w in enumerate(module.split("_")))


_COUNTRIES: dict[str, str] | None = None


def holiday_countries() -> dict[str, str]:
    """Every country the ``holidays`` library knows: ISO code → name (by name)."""
    global _COUNTRIES
    if _COUNTRIES is None:
        from holidays import registry

        _COUNTRIES = dict(sorted(((v[1], _country_name(k)) for k, v in registry.COUNTRIES.items()), key=lambda x: x[1]))
    return _COUNTRIES


_ZONE_COUNTRY: dict[str, str] | None = None


def guess_country(tz: str) -> str | None:
    """The country a time zone is in (from the system's ``zone.tab``), when
    the holidays library knows it."""
    global _ZONE_COUNTRY
    if _ZONE_COUNTRY is None:
        found: dict[str, str] = {}
        for path in ("/usr/share/zoneinfo/zone.tab", "/usr/share/zoneinfo/zone1970.tab"):
            try:
                with open(path, encoding="utf-8") as fh:
                    for line in fh:
                        parts = line.rstrip("\n").split("\t")
                        if line.startswith("#") or len(parts) < 3:
                            continue
                        # zone1970 lists several countries ("AU,AQ"): the first.
                        found.setdefault(parts[2], parts[0].split(",")[0])
            except OSError:
                continue
        _ZONE_COUNTRY = found
    code = _ZONE_COUNTRY.get(tz)
    return code if code and code in holiday_countries() else None


_HOLIDAY_CACHE: dict[tuple[str, int], list[tuple[str, str]]] = {}


def _year_holidays(country: str, year: int) -> list[tuple[str, str]]:
    key = (country, year)
    if key not in _HOLIDAY_CACHE:
        import holidays

        cls = type(holidays.country_holidays(country))
        langs = list(getattr(cls, "supported_languages", ()) or ())
        # Names in English where the country has them.
        lang = next((x for x in ("en_US", "en_GB", "en_AU", "en_CA", "en_NZ", "en_IN") if x in langs), None)
        h = holidays.country_holidays(country, years=year, language=lang) if lang else holidays.country_holidays(country, years=year)
        if len(_HOLIDAY_CACHE) > 200:
            _HOLIDAY_CACHE.clear()
        _HOLIDAY_CACHE[key] = sorted((d.isoformat(), name) for d, name in h.items())
    return _HOLIDAY_CACHE[key]


def holidays_in(country: str, start: date, end: date) -> list[dict]:
    """Public holidays in ``country`` in [start, end)."""
    if country not in holiday_countries():
        return []
    out: list[dict] = []
    for y in range(start.year, end.year + 1):
        for day, name in _year_holidays(country, y):
            if start.isoformat() <= day < end.isoformat():
                # Two holidays on one day come joined ("A; B"): one each.
                out.extend({"day": day, "name": n.strip(), "country": country} for n in name.split(";") if n.strip())
    return out


# ------------------------------------------------------------------ planned tasks


async def planned_tasks(db: AsyncSession, user: User) -> dict[tuple[str, str], dict]:
    """(tasks file, task id) → the event it's planned as (the latest one)."""
    from sqlalchemy import select

    from .core import iso
    from .models import CalEvent

    rows = (
        await db.execute(
            select(CalEvent.id, CalEvent.source, CalEvent.start_at, CalEvent.end_at)
            .where(CalEvent.created_by == user.id, CalEvent.source.is_not(None), CalEvent.source["kind"].astext == "task")
            .order_by(CalEvent.start_at)
            .limit(2000)
        )
    ).all()
    out: dict[tuple[str, str], dict] = {}
    for r in rows:
        src = r.source or {}
        out[(str(src.get("file_id")), str(src.get("task_id")))] = {"event_id": str(r.id), "start": iso(r.start_at, False), "end": iso(r.end_at, False)}
    return out


async def task_status(db: AsyncSession, user: User, file_id: uuid.UUID, task_id: str) -> dict:
    """A planned task's title and whether it's done (for the event's "Done" box)."""
    from app.items import service

    for row, doc in await service.list_items(db, user, "tasks", archives=False):
        if row.id != file_id:
            continue
        for t in (doc.data or {}).get("tasks", []):
            if t.get("id") == task_id:
                return {"exists": True, "done": bool(t.get("done")), "title": t.get("title", ""), "repeats": bool(t.get("repeat"))}
    return {"exists": False, "done": False, "title": "", "repeats": False}

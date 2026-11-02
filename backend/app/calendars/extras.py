"""What else shows on your calendar: tasks with a due date (from your Tasks
app) and birthdays / anniversaries (from Contacts, with the person's face
from Photos when they're linked). Read-only here — ticking a task off goes
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

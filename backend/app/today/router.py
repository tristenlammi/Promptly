"""Today (#U2) and the everyday half of the search box (#U11).

    GET  /api/today            the day: events, tasks, habits, workout, meals,
                               on-this-day photos, unread rooms, my work
    PUT  /api/today/morning    the morning summary push: on/off and time
    GET  /api/today/search     events, contacts and tasks matching ``q``

Search covers your calendar events (not free/busy-only calendars, not ones
you removed), your Contacts and your Tasks. Rooms messages are never
searched here — they're private to each room.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

logger = logging.getLogger("promptly.today")

router = APIRouter()


@router.get("")
async def today(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from . import core, hub, push

    out = await core.build(db, user)
    await hub.extend(db, user, out)
    out["morning"] = await push.prefs(db, user)
    return out


class MorningIn(BaseModel):
    on: bool
    time: str = Field(default="08:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


@router.put("/morning")
async def set_morning(body: MorningIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from . import push

    return await push.set_prefs(db, user, body.on, body.time)


# ------------------------------------------------------------------ search


def _hit(text: str, q: str) -> bool:
    return q in (text or "").lower()


def search_contacts(file_id, data: dict, q: str, limit: int) -> list[dict]:  # noqa: ANN001
    from app.items.kinds.contacts.logic import display_name

    out = []
    for c in data.get("contacts", []):
        name = display_name(c)
        hay = [name, c.get("nickname", ""), c.get("company", ""), c.get("title", ""), *c.get("tags", [])]
        hay += [x.get("value", "") for x in c.get("emails", [])]
        phones = [x.get("value", "") for x in c.get("phones", [])]
        digits = re.sub(r"\D", "", q)
        if any(_hit(h, q) for h in hay) or (len(digits) >= 3 and any(digits in re.sub(r"\D", "", p) for p in phones)):
            sub = " · ".join(x for x in (c.get("company", ""), (c.get("emails") or [{}])[0].get("value", ""), (c.get("phones") or [{}])[0].get("value", "")) if x)
            out.append({"id": c["id"], "name": name, "detail": sub, "favorite": bool(c.get("favorite")),
                        "url": f"/apps/contacts/{file_id}?c={c['id']}"})
    out.sort(key=lambda h: (not h["name"].lower().startswith(q), not h["favorite"], h["name"].lower()))
    return out[:limit]


def search_tasks(file_id, data: dict, q: str, limit: int) -> list[dict]:  # noqa: ANN001
    from app.items.kinds.tasks import logic as L

    hits = [t for t in data.get("tasks", []) if _hit(t.get("title", ""), q) or _hit(t.get("notes", ""), q) or any(_hit(x, q) for x in t.get("tags", []))]
    hits.sort(key=lambda t: (t["done"], L.sort_key(t)))
    return [
        {"id": t["id"], "title": t["title"], "done": t["done"], "due": t.get("due"), "time": t.get("time"),
         "list": L.list_name(data, t.get("list_id", "inbox")), "url": f"/apps/tasks/{file_id}"}
        for t in hits[:limit]
    ]


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.calendars import lookup
    from app.items import service

    term = q.strip().lower()
    if len(term) < 2:
        return {"events": [], "contacts": [], "tasks": [], "mail": []}
    events = [
        {"id": e["id"], "event_id": e["event_id"], "title": e["title"], "start": e["start"], "all_day": e["all_day"],
         "location": e.get("location") or "", "url": f"/calendar?event={e['event_id']}"}
        for e in await lookup.search(db, user, q, limit=limit * 2)
        if not e.get("busy_only")
    ][:limit]
    contacts: list[dict] = []
    for row, doc in await service.list_items(db, user, "contacts", limit=5, archives=False):
        contacts += search_contacts(row.id, doc.data or {}, term.lstrip("#"), limit)
    tasks: list[dict] = []
    for row, doc in await service.list_items(db, user, "tasks", limit=5, archives=False):
        tasks += search_tasks(row.id, doc.data or {}, term.lstrip("#"), limit)
    # Shared tags (#tags): matching tags, and events carrying one by name.
    from app.tags import search_hook

    tags, tagged_events = await search_hook.everyday(db, user, term, limit, {e["event_id"] for e in events})
    events = (events + tagged_events)[:limit]
    mail: list[dict] = []
    try:
        from app.mail.apps import quick_search

        mail = await quick_search(db, user, q.strip(), limit)
    except Exception:  # noqa: BLE001 — the other results still matter
        logger.exception("mail search failed")
    porch: list[dict] = []
    try:
        from app.porch.search import quick as porch_quick

        porch = await porch_quick(db, user, q.strip(), limit)
    except Exception:  # noqa: BLE001
        logger.exception("porch search failed")
    return {"events": events, "contacts": contacts[:limit], "tasks": tasks[:limit], "tags": tags, "mail": mail, "porch": porch}

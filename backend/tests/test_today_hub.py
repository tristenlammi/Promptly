"""The Today hub (app/today/hub.py): every app's section appears with real
data — a failing section is dropped quietly on the page, so these require
each one — plus the schedule, what needs you, the week ahead and progress."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _hdr(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _app(db, user, kind) -> uuid.UUID:
    from app.items import service

    row, _ = await service.open_app(db, user, kind)
    await db.commit()
    return row.id


async def _do(client, user, fid, name, args):
    r = await client.post(f"/api/items/{fid}/actions/{name}", headers=_hdr(user), json={"args": args})
    assert r.status_code == 200, f"{name}: {r.text}"
    return r.json()


async def _today(client, user) -> dict:
    r = await client.get("/api/today", headers=_hdr(user))
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_medication_due_now_is_on_today_and_can_be_taken(db, user, client):
    fid = await _app(db, user, "health")
    await _do(client, user, fid, "add_medication", {"name": "Vitamin D", "dose": "1000 IU", "schedule_type": "daily", "times": ["00:00"]})

    t = await _today(client, user)
    h = t["sections"]["health"]
    assert [(d["name"], d["state"]) for d in h["doses"]] == [("Vitamin D", "due")]
    assert h["doses_due"] == 1
    # It's the first thing that needs you, and on the schedule.
    assert t["attention"][0]["kind"] == "med" and "Vitamin D" in t["attention"][0]["title"]
    med = next(i for i in t["schedule"]["items"] if i["kind"] == "med")
    assert med["time"] == "00:00" and med["due"] and not med["done"]
    assert t["progress"] == {"done": 0, "total": 1, "pct": 0}

    # Taking it (what the card's button sends) clears all of that.
    d = h["doses"][0]
    await _do(client, user, fid, "log_dose", {"doses": [{"med": d["med_id"], "slot": d["time"]}]})
    t = await _today(client, user)
    h = t["sections"]["health"]
    assert h["doses_due"] == 0 and h["doses_taken"] == 1
    assert not [a for a in t["attention"] if a["kind"] == "med"]
    assert next(i for i in t["schedule"]["items"] if i["kind"] == "med")["done"]
    assert t["progress"]["pct"] == 100


async def test_a_dose_is_due_by_your_own_clock_not_utc(db, user, client):
    """Far from UTC: a slot an hour ago on your clock is due now."""
    from zoneinfo import ZoneInfo

    user.settings = {**(user.settings or {}), "timezone": "Pacific/Kiritimati"}  # UTC+14
    await db.commit()
    local = datetime.now(ZoneInfo("Pacific/Kiritimati"))
    slot = "00:00" if local.hour == 0 else (local - timedelta(hours=1)).strftime("%H:%M")
    fid = await _app(db, user, "health")
    await _do(client, user, fid, "add_medication", {"name": "Vitamin D", "schedule_type": "daily", "times": [slot]})

    t = await _today(client, user)
    assert t["sections"]["health"]["doses"][0]["state"] == "due"
    assert t["attention"][0]["kind"] == "med"


async def test_every_app_section_appears_with_real_data(db, user, client):
    today = date.today()
    soon = (today + timedelta(days=3)).isoformat()

    health = await _app(db, user, "health")
    await _do(client, user, health, "log_metrics", {"readings": [{"metric": "weight", "value": 80.5, "unit": "kg"}]})
    at = (datetime.now(timezone.utc) + timedelta(days=2)).replace(microsecond=0).isoformat()
    await _do(client, user, health, "add_appointment", {"at": at, "title": "GP check-up", "who": "Dr Lee"})

    meals = await _app(db, user, "meals")
    await _do(client, user, meals, "set_targets", {"kcal": 2200, "protein": 160, "carbs": 220, "fat": 70, "water_ml": 2500})
    await _do(client, user, meals, "log_water", {"ml": 500})

    budget = await _app(db, user, "budget")
    await _do(client, user, budget, "add_subscription", {"name": "Netflix", "amount": 17.99, "next_due": today.isoformat(), "kind": "bill"})

    trip = await _app(db, user, "trip")
    await _do(client, user, trip, "create_trip", {"title": "Japan", "start": soon, "end": (today + timedelta(days=10)).isoformat()})

    cards = await _app(db, user, "flashcards")
    await _do(client, user, cards, "add_cards", {"deck": "Spanish", "cards": [{"front": "hola", "back": "hello"}]})

    journal = await _app(db, user, "journal")
    await _do(client, user, journal, "add_entry", {"person_asked": True, "date": today.isoformat(), "body": "A good day"})

    contacts = await _app(db, user, "contacts")
    await _do(client, user, contacts, "add_contacts", {"contacts": [{"full_name": "Sam Lee", "birthday": f"1990-{today:%m-%d}"}]})

    tasks = await _app(db, user, "tasks")
    await _do(client, user, tasks, "add_tasks", {"tasks": [{"title": "Later this week", "due": soon}]})

    t = await _today(client, user)
    s = t["sections"]
    assert s["health"]["weight"].startswith("80.5")
    assert s["health"]["weight_series"] == [80.5] and s["health"]["weight_change"] is None
    assert len(s["nutrition"]["kcal_series"]) == 14 and s["nutrition"]["kcal_series"][-1] is None  # nothing logged isn't zero
    for g in s["health"]["goals"]:
        assert len(g["series"]) == 14
    assert s["health"]["appointments"][0]["title"] == "GP check-up"
    assert s["nutrition"]["kcal_target"] == 2200 and s["nutrition"]["water_ml"] == 500
    assert [m["key"] for m in s["nutrition"]["macros"]] == ["protein", "carbs", "fat"]
    assert s["budget"]["bills"][0]["name"] == "Netflix"
    assert s["trip"]["title"] == "Japan" and s["trip"]["phase"] == "before" and s["trip"]["days_to_go"] == 3
    assert s["study"]["due"] == 1
    assert s["journal"]["wrote_today"] and s["journal"]["streak"] == 1
    assert s["people"]["dates"][0]["name"] == "Sam Lee" and s["people"]["dates"][0]["in_days"] == 0

    kinds = {a["kind"] for a in t["attention"]}
    assert {"bill", "person"} <= kinds
    assert any(i["kind"] == "person" for i in t["schedule"]["all_day"])
    coming = {c["kind"]: c for c in t["coming"]}
    assert {"appointment", "trip", "task"} <= set(coming)
    assert [c["date"] for c in t["coming"]] == sorted(c["date"] for c in t["coming"])
    # Apps they've added aren't suggested again.
    assert not {d["kind"] for d in t["discover"]} & {"health", "meals", "budget", "trip", "flashcards", "journal", "contacts", "tasks"}


async def test_nothing_set_up_is_a_clean_page(db, user, client):
    from app.items.models import ItemInstall
    from sqlalchemy import delete

    await db.execute(delete(ItemInstall).where(ItemInstall.user_id == user.id))
    await db.commit()
    t = await _today(client, user)
    assert t["attention"] == [] and t["coming"] == [] and t["progress"] is None
    assert t["schedule"] == {"items": [], "all_day": []}
    assert t["discover"]  # …and it suggests where to start


async def test_one_broken_app_costs_its_card_not_the_page(db, user, client, monkeypatch):
    from app.today import hub

    fid = await _app(db, user, "health")
    await _do(client, user, fid, "add_medication", {"name": "Vitamin D", "schedule_type": "daily", "times": ["00:00"]})
    await _app(db, user, "journal")

    def boom(*a, **k):
        raise RuntimeError("journal is broken")

    monkeypatch.setattr(hub, "journal_section", boom)
    t = await _today(client, user)
    assert "journal" not in t["sections"]
    assert t["sections"]["health"]["doses_due"] == 1


async def test_only_your_own_apps_show(db, user, client):
    """Someone else's medication never reaches your Today."""
    from app.auth.models import User
    from app.auth.utils import hash_password

    other = User(email="hub-other@example.com", username="hubother", password_hash=hash_password("x" * 16), role="user", settings={})
    db.add(other)
    await db.commit()
    fid = await _app(db, other, "health")
    await _do(client, other, fid, "add_medication", {"name": "Their pills", "schedule_type": "daily", "times": ["00:00"]})

    t = await _today(client, user)
    assert "Their pills" not in str(t)

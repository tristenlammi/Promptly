""""Read me my day" (Talk phase 2, WP-T12).

What's checked: each section in and out; a failing section is skipped; the
120-word cap; weather off and on (a mocked Open-Meteo), and a cache hit;
leave-by from the maps card; the car's version drops the email count; your
chosen sections; the endpoint; and the phrase in Talk, with no model.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.today import briefing, weather

from .talk_fakes import Model, bearer
from .test_talk_turns import finish, open_talk, sidecars, talk_app, use_model  # noqa: F401

NOW = datetime(2026, 11, 9, 22, 0, tzinfo=timezone.utc)  # 8 AM in Brisbane

DAY = {
    "events": {"events": [
        {"title": "Dentist", "start": "2026-11-10T09:00:00+10:00", "all_day": False, "location": "Harbour St"},
        {"title": "Call with Sam", "start": "2026-11-10T14:00:00+10:00", "all_day": False},
        {"title": "Bins", "start": "2026-11-10", "all_day": True},
        {"title": "Book club", "start": "2026-11-10T19:30:00+10:00", "all_day": False},
    ]},
    "maps": {"next": {"title": "Dentist", "leave_by_label": "8:35 am"}},
    "tasks": {"today_count": 2, "overdue_count": 1, "overdue": [{"title": "Renew rego"}], "today": [{"title": "Call the plumber"}, {"title": "Water plants"}]},
    "budget": {"bills": [{"name": "Rates", "date": "2026-11-10", "amount": "$420.00"}, {"name": "Phone", "date": "2026-11-12", "amount": "$45.00"}]},
    "people": {"dates": [{"name": "Sam", "kind": "birthday", "in_days": 0}, {"name": "Mum", "kind": "birthday", "in_days": 1}, {"name": "Jo", "kind": "anniversary", "in_days": 0}]},
    "mail": {"unread": 12},
}

FORECAST = {
    "daily": {"weather_code": [0], "temperature_2m_max": [31.2], "temperature_2m_min": [19.0]},
    "hourly": {
        "time": [f"2026-11-10T{h:02d}:00" for h in range(24)],
        "weather_code": [0] * 15 + [95] * 9,
        "precipitation_probability": [0] * 15 + [70] * 9,
    },
}


@pytest.fixture
def today(monkeypatch):
    """Today's sections, as core.build + hub.extend would make them."""
    from app.today import core, hub

    state = {"sections": {k: v for k, v in DAY.items()}}

    async def build(db, user, now=None, *, photos=True):
        return {"tz": "Australia/Brisbane", "now": now.isoformat(), "sections": dict(state["sections"])}

    async def extend(db, user, out):
        return out

    monkeypatch.setattr(core, "build", build)
    monkeypatch.setattr(hub, "extend", extend)
    monkeypatch.setattr(core, "zone_of", lambda user: __import__("zoneinfo").ZoneInfo("Australia/Brisbane"))
    return state


@pytest.fixture
def no_weather(monkeypatch):
    async def none(db, user, now):
        return None

    monkeypatch.setattr(weather, "line", none)


async def test_every_section_in_order(db, user, today, no_weather):
    got = await briefing.build(db, user, now=NOW)
    keys = [s["key"] for s in got["sections"]]
    assert keys == ["events", "tasks", "bills", "birthdays", "mail"]
    script = got["script"]
    assert script.startswith("Good morning") and script.endswith(briefing.END)
    assert "4 things today: Dentist at 9 AM, Call with Sam at 2 PM and Bins, and 1 more." in script
    assert "Leave by 8:35 AM for Dentist." in script
    assert "2 tasks due today and 1 overdue: Renew rego and Call the plumber." in script
    assert "Bills due: Rates, $420.00, today and Phone, $45.00, on Thursday." in script
    assert "It's Sam's birthday today. Mum's birthday is tomorrow." in script
    assert "Jo" not in script
    assert "12 unread emails." in script
    assert len(script.split()) <= briefing.MAX_WORDS + 5


async def test_sections_come_and_go(db, user, today, no_weather):
    today["sections"] = {"tasks": {"today_count": 0, "overdue_count": 0}}
    got = await briefing.build(db, user, now=NOW)
    assert [s["key"] for s in got["sections"]] == ["tasks"]
    assert got["sections"][0]["text"] == "No tasks due today."
    today["sections"] = {}
    got = await briefing.build(db, user, now=NOW)
    assert got["sections"] == [] and "There's nothing on today." in got["script"]


async def test_a_failing_section_is_left_out(db, user, today, no_weather, monkeypatch):
    def boom(sec):
        raise RuntimeError("tasks broke")

    monkeypatch.setattr(briefing, "tasks_line", boom)
    got = await briefing.build(db, user, now=NOW)
    keys = [s["key"] for s in got["sections"]]
    assert "tasks" not in keys and "events" in keys and "mail" in keys


async def test_the_word_cap(db, user, today, no_weather, monkeypatch):
    full = await briefing.build(db, user, now=NOW)
    assert len(full["script"].split()) <= briefing.MAX_WORDS + 5
    # Tighter: later sections give way first, the events stay.
    monkeypatch.setattr(briefing, "MAX_WORDS", 40)
    got = await briefing.build(db, user, now=NOW)
    keys = [s["key"] for s in got["sections"]]
    assert keys == [k for k in ("events", "tasks", "bills", "birthdays", "mail") if k in keys]
    assert keys[0] == "events" and "mail" not in keys
    assert len(" ".join(s["text"] for s in got["sections"]).split()) + 2 <= 40


async def test_the_car_leaves_out_email_and_your_choice_is_kept(db, user, today, no_weather):
    got = await briefing.build(db, user, car=True, now=NOW)
    assert "mail" not in [s["key"] for s in got["sections"]]
    user.settings = {"briefing_sections": ["birthdays", "events"]}
    got = await briefing.build(db, user, now=NOW)
    assert [s["key"] for s in got["sections"]] == ["events", "birthdays"]


async def test_weather_on_off_and_cached(db, user, monkeypatch):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.maps.models import MapPlace
    from app.redis_client import redis

    calls: list = []

    async def fetch(lat, lon):
        calls.append((lat, lon))
        return FORECAST

    monkeypatch.setattr(weather, "_fetch", fetch)
    local = NOW.astimezone(__import__("zoneinfo").ZoneInfo("Australia/Brisbane"))
    # No Home place: no weather.
    assert await weather.line(db, user, local) is None
    db.add(MapPlace(user_id=user.id, kind="home", name="Home", lat=-27.46789, lon=153.02345))
    await db.commit()
    await redis.delete("weather:-27.5,153.0")
    said = await weather.line(db, user, local)
    assert said == "Sunny, 31 degrees. A storm likely after three."
    assert calls == [(-27.5, 153.0)]  # rounded to ~10 km
    assert await weather.line(db, user, local) == said
    assert len(calls) == 1  # from the cache
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.weather_enabled = False
    await db.commit()
    assert await weather.line(db, user, local) is None
    await redis.delete("weather:-27.5,153.0")


def test_weather_words():
    now = datetime(2026, 11, 10, 8, 0)
    assert weather.describe({"daily": {"weather_code": [61], "temperature_2m_max": [22]}}, now) == "Rainy, 22 degrees."
    assert weather.describe({}, now) is None
    rain = {**FORECAST, "hourly": {**FORECAST["hourly"], "weather_code": [0] * 13 + [61] * 11, "precipitation_probability": [0] * 13 + [80] * 11}}
    assert weather.describe(rain, now) == "Sunny, 31 degrees. Rain likely after one."


def test_the_phrases():
    for yes in ("Read me my day", "read me my day please", "Brief me.", "Morning briefing", "Hey Promptly, read me my day"):
        assert briefing.asked(yes), yes
    for no in ("read me the news", "what's on tomorrow"):
        assert not briefing.asked(no), no


async def test_the_endpoint(db, user, today, no_weather, talk_app):
    import httpx

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=talk_app), base_url="http://test") as http:
        r = await http.get("/api/today/briefing", headers=bearer(user))
        assert r.status_code == 200
        body = r.json()
        assert body["script"].endswith(briefing.END) and {s["key"] for s in body["sections"]} >= {"events", "mail"}
        r = await http.get("/api/today/briefing?car=true", headers=bearer(user))
        assert "mail" not in {s["key"] for s in r.json()["sections"]}


async def test_read_me_my_day_in_talk_needs_no_model(db, user, conversation, today, no_weather, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["Unused."]))
    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    await live.say(1, "Read me my day.")
    done = await c.find("reply", done=True)
    assert "4 things today" in done["text"]
    await c.expect("state", state="listening", timeout=20)
    assert model.calls == []
    await finish(c)

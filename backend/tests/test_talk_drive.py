"""Driving by voice (Talk phase 2, WP-T9), end to end through Talk's socket.

What's checked: the trip reaches the model as words, never coordinates; its
tools are offered only while a trip is running; ``add_stop`` works by kind and
by saved place and goes to the phone as an action; ``end_trip`` and
``check_route`` work and end the turn on what they said; ``trip_status`` reads
the trip; a ``trip`` message replaces the one from the hello.
"""
from __future__ import annotations

import json

import pytest

from app.talk import drive

from .talk_fakes import Model
from .test_talk_turns import finish, open_talk, sidecars, talk_app, use_model  # noqa: F401

TRIP = {
    "to": {"name": "Home", "lat": -27.5123, "lon": 153.0456},
    "arrive_at": "2026-11-09T07:40:00+00:00",
    "left_s": 1440,
    "left_m": 18200,
    "delay_min": 4,
    "lat": -27.4321,
    "lon": 152.9876,
    "shape": "fake_polyline",
}
CAR = {"device": "car", "caps": ["timer", "alarm", "navigate"], "turn_mode": "tap", "interrupt_mode": "tap", "tz": "Australia/Brisbane"}


@pytest.fixture
async def phone_user(db, user, provider):
    user.settings = {"default_provider_id": str(provider.id), "default_model_id": "test-model"}
    await db.commit()
    return user


def everything_the_model_saw(model: Model) -> str:
    return json.dumps([m if isinstance(m, dict) else getattr(m, "__dict__", str(m)) for call in model.calls for m in call], default=str) + " ".join(
        str(k.get("system") or "") for k in model.kwargs
    )


async def test_the_trip_reaches_the_model_without_coordinates(db, phone_user, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["About twenty-four minutes."]))
    c = await open_talk(talk_app, phone_user, trip=TRIP, **CAR)
    live = await sidecars.live()
    await live.say(1, "How long to go?")
    await c.find("reply", done=True)
    seen = everything_the_model_saw(model)
    assert "Heading to Home" in seen and "Arriving about 5:40 PM" in seen
    assert "Traffic is adding about 4 minutes" in seen
    for secret in ("-27.4321", "152.9876", "-27.5123", "153.0456", "fake_polyline"):
        assert secret not in seen
    offered = model.tools_offered()
    assert set(drive.NAMES) <= offered
    await finish(c)


async def test_with_no_trip_the_drive_tools_are_absent(db, phone_user, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["Nothing on."]))
    c = await open_talk(talk_app, phone_user, **CAR)
    live = await sidecars.live()
    await live.say(1, "What's on today?")
    await c.find("reply", done=True)
    assert not set(drive.NAMES) & model.tools_offered()
    assert "driving right now" not in everything_the_model_saw(model)
    await finish(c)


async def test_add_stop_by_category_goes_to_the_phone(db, phone_user, sidecars, talk_app, monkeypatch):
    from app.maps import assistant

    asked: list = []

    async def candidates(category, state):
        asked.append((category, state.lat, state.lon, state.shapes, (state.to or {}).get("name")))
        return [{"name": "Shell", "address": "12 Cobra Street, Brisbane", "kind": "place", "lat": -27.45, "lon": 152.99, "adds_seconds": 120, "along_m": 2500}]

    monkeypatch.setattr(assistant, "_candidates", candidates)
    model = use_model(monkeypatch, Model([{"tool": "add_stop", "args": {"category": "fuel"}}, "Unused."]))
    c = await open_talk(talk_app, phone_user, trip=TRIP, **CAR)
    live = await sidecars.live()
    await live.say(1, "Add a stop for fuel.")
    action = await c.expect("action", timeout=10)
    assert action["action"] == {"type": "add_stop", "stop": {"lat": -27.45, "lon": 152.99, "name": "Shell"}}
    await c.expect("state", state="listening", timeout=15)
    spoken = " ".join(sidecars.spoken)
    assert "Adding Shell on Cobra Street" in spoken and "adds about 2 minutes" in spoken
    # The position and the road went to the look-up, not the model.
    assert asked == [("fuel", -27.4321, 152.9876, ["fake_polyline"], "Home")]
    assert len(model.calls) == 1  # said straight from the tool
    await finish(c)


async def test_add_stop_by_saved_place(db, phone_user, sidecars, talk_app, monkeypatch):
    from app.maps import nearby, router as maps_router

    async def places(db_, user_, query, near):
        assert near == {"lat": -27.4321, "lon": 152.9876}
        return [{"kind": "work", "name": "Work", "address": "1 Queen Street, Brisbane", "lat": -27.47, "lon": 153.02}]

    async def detours(rows, here, to, mode="drive", limit=8):
        return [{**rows[0], "adds_seconds": 420}]

    monkeypatch.setattr(maps_router, "find_places", places)
    monkeypatch.setattr(nearby, "with_detours", detours)
    use_model(monkeypatch, Model([{"tool": "add_stop", "args": {"place": "work"}}, "Unused."]))
    c = await open_talk(talk_app, phone_user, trip=TRIP, **CAR)
    live = await sidecars.live()
    await live.say(1, "Add a stop at work.")
    action = await c.expect("action", timeout=10)
    assert action["action"]["type"] == "add_stop" and action["action"]["stop"]["name"] == "Work"
    await c.expect("state", state="listening", timeout=15)
    assert "adds about 7 minutes" in " ".join(sidecars.spoken)
    await finish(c)


async def test_end_trip_and_check_route(db, phone_user, sidecars, talk_app, monkeypatch):
    from app.maps import assistant

    checked: list = []

    async def check(db_, user_, state):
        checked.append((state.shapes, state.km))
        return "There's a crash 4 kilometres ahead, adding 6 minutes."

    monkeypatch.setattr(assistant, "_check", check)
    model = use_model(
        monkeypatch,
        Model([{"tool": "check_route", "args": {}}, {"tool": "end_trip", "args": {}}, "Unused."]),
    )
    c = await open_talk(talk_app, phone_user, trip=TRIP, **CAR)
    live = await sidecars.live()
    await live.say(1, "Is the way clear?")
    await c.expect("state", state="listening", timeout=15)
    assert "There's a crash 4 kilometres ahead" in " ".join(sidecars.spoken)
    assert checked == [(["fake_polyline"], 18.2)]
    await live.say(2, "Stop navigating.")
    action = await c.expect("action", timeout=10)
    assert action["action"] == {"type": "end_trip"}
    await c.expect("state", state="listening", timeout=15)
    assert "Stopping directions." in sidecars.spoken
    assert len(model.calls) == 2
    await finish(c)


async def test_trip_status_reads_the_trip_and_a_new_trip_message_wins(db, phone_user, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model([{"tool": "trip_status", "args": {}}, "You'll be there at about five to six."]))
    c = await open_talk(talk_app, phone_user, trip=TRIP, **CAR)
    await c.send({"type": "trip", **TRIP, "to": {"name": "Mum's", "lat": -27.6, "lon": 153.1}, "arrive_at": "2026-11-09T07:55:00+00:00", "next_stop": "Shell"})
    live = await sidecars.live()
    await live.say(1, "Will I make it by six?")
    await c.find("reply", done=True)
    result = json.dumps([m if isinstance(m, dict) else m.__dict__ for m in model.calls[-1]], default=str)
    assert "Heading to Mum's" in result and "Arriving about 5:55 PM" in result and "Next stop: Shell" in result
    assert "-27.6" not in result
    await finish(c)


async def test_a_trip_ending_takes_the_tools_away(db, phone_user, sidecars, talk_app, monkeypatch):
    model = use_model(monkeypatch, Model(["Okay."]))
    c = await open_talk(talk_app, phone_user, trip=TRIP, **CAR)
    await c.send({"type": "trip", "to": None})
    live = await sidecars.live()
    await live.say(1, "What now?")
    await c.find("reply", done=True)
    assert not set(drive.NAMES) & model.tools_offered()
    await finish(c)


def test_the_trip_is_checked():
    assert drive.parse({"to": "Home"})["to"]["name"] == "Home"
    assert drive.parse({"to": None}) is None
    assert drive.parse({"to": {"name": "x"}, "lat": 999}) is None
    assert drive.parse("nonsense") is None
    assert drive.arrival({"arrive_at": "2026-11-09T07:40:00Z"}, "Australia/Brisbane") == "5:40 PM"

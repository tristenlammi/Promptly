"""The phone app's GPS for the P Maps page: taken only while the page asks,
read only by the person whose phone it is, kept nowhere."""
from __future__ import annotations

import httpx
import pytest

from tests.test_maps_timeline import _hdr, _other

KEY = "k" * 43
HERE = {"key": KEY, "lat": -27.47, "lon": 153.02, "accuracy": 6.0, "heading": 90.0, "speed": 3.0}


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app
    from app.maps import phone_location

    phone_location.reset()
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True
        phone_location.reset()


async def _ask(client, user, key=KEY):
    return await client.post("/api/maps/phone-location/ask", headers=_hdr(user), json={"key": key})


async def test_a_fix_reaches_the_page_that_asked(user, client):
    assert (await _ask(client, user)).json() == {"fix": None}
    assert (await client.post("/api/maps/phone-location/fix", json=HERE)).json() == {"wanted": True}
    fix = (await _ask(client, user)).json()["fix"]
    assert (fix["lat"], fix["lon"], fix["accuracy"], fix["heading"]) == (-27.47, 153.02, 6.0, 90.0)
    assert fix["age"] < 5


async def test_nothing_is_taken_until_a_page_asks(user, client):
    """An unknown key and an unwanted one look the same, and keep nothing."""
    from app.maps import phone_location

    assert (await client.post("/api/maps/phone-location/fix", json=HERE)).json() == {"wanted": False}
    assert phone_location._slots == {}
    assert (await _ask(client, user)).json() == {"fix": None}


async def test_the_app_can_ask_whether_it_is_wanted_without_a_position(user, client):
    assert (await client.post("/api/maps/phone-location/fix", json={"key": KEY})).json() == {"wanted": False}
    await _ask(client, user)
    assert (await client.post("/api/maps/phone-location/fix", json={"key": KEY})).json() == {"wanted": True}
    assert (await _ask(client, user)).json() == {"fix": None}


async def test_it_stops_when_the_page_stops_asking(user, client, monkeypatch):
    from app.maps import phone_location

    clock = [1000.0]
    monkeypatch.setattr(phone_location, "_now", lambda: clock[0])
    await _ask(client, user)
    assert (await client.post("/api/maps/phone-location/fix", json=HERE)).json() == {"wanted": True}
    clock[0] += phone_location.LEASE_S + 1
    assert (await client.post("/api/maps/phone-location/fix", json=HERE)).json() == {"wanted": False}
    # ...and where they were isn't kept for the next look.
    assert (await _ask(client, user)).json() == {"fix": None}


async def test_an_old_fix_is_not_where_you_are(user, client, monkeypatch):
    from app.maps import phone_location

    clock = [1000.0]
    monkeypatch.setattr(phone_location, "_now", lambda: clock[0])
    await _ask(client, user)
    await client.post("/api/maps/phone-location/fix", json=HERE)
    clock[0] += phone_location.FRESH_S + 1
    assert (await _ask(client, user)).json() == {"fix": None}


async def test_nobody_else_can_read_it_or_take_the_key(db, user, client):
    other = await _other(db)
    await _ask(client, user)
    await client.post("/api/maps/phone-location/fix", json=HERE)
    r = await _ask(client, other)
    assert r.status_code == 409 and "lat" not in r.text
    # Still the owner's.
    assert (await _ask(client, user)).json()["fix"]["lat"] == -27.47
    # Their own key shows them nothing of anyone else's.
    assert (await _ask(client, other, key="o" * 43)).json() == {"fix": None}


async def test_an_admin_is_nobody_special(db, user, client):
    from app.auth.models import User

    admin = User(email="adm-pl@example.com", username="admpl", password_hash="x", role="admin", settings={})
    db.add(admin)
    await db.commit()
    await _ask(client, user)
    await client.post("/api/maps/phone-location/fix", json=HERE)
    assert (await _ask(client, admin)).status_code == 409


async def test_asking_needs_a_session_and_a_proper_key(user, client):
    assert (await client.post("/api/maps/phone-location/ask", json={"key": KEY})).status_code == 401
    assert (await _ask(client, user, key="short")).status_code == 422
    assert (await client.post("/api/maps/phone-location/fix", json={**HERE, "lat": 123})).status_code == 422


async def test_nothing_is_written_to_the_database(db, user, client):
    from sqlalchemy import func, select

    from app.maps.models import MapLiveLocation, MapTrackPoint

    await _ask(client, user)
    await client.post("/api/maps/phone-location/fix", json=HERE)
    assert (await db.execute(select(func.count()).select_from(MapTrackPoint))).scalar() == 0
    assert (await db.execute(select(func.count()).select_from(MapLiveLocation))).scalar() == 0

"""Silence is never silent: the server knows when it last heard from the
phone and says so (the timeline), and everyone sees how old a shared position
is, with the person sharing told when their phone stops sending."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

T0 = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc)  # 10 am in Brisbane


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


@pytest.fixture(autouse=True)
def told(monkeypatch):
    """Starting a share tells your own phone; nothing here really pushes."""
    from app.maps import timeline

    sent = []

    async def fake(**kwargs):
        sent.append(kwargs)

    monkeypatch.setattr(timeline, "notify_user", fake)
    return sent


@pytest.fixture
def no_photon(monkeypatch):
    from app.maps import engine

    async def fake(path, params):
        return []

    monkeypatch.setattr(engine, "photon", fake)


def _hdr(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _other(db):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user", settings={})
    db.add(other)
    await db.commit()
    return other


def _p(minutes, lat, lon):
    return {"at": (T0 + timedelta(minutes=minutes)).isoformat(), "lat": lat, "lon": lon}


def _drive():
    return [_p(m, -27.5 + m * 0.002, 153.0) for m in range(20)]


async def _turn_on(client, user):
    r = await client.put("/api/maps/timeline/settings", headers=_hdr(user), json={"timeline_on": True})
    assert r.status_code == 200 and r.json()["timeline_on"]


# ---- The timeline ---------------------------------------------------------------


async def test_one_bad_position_doesnt_refuse_the_rest(user, client):
    """A phone sends up to a thousand at once, and sends the same batch again
    until it's taken: one odd row used to refuse them all, for ever."""
    await _turn_on(client, user)
    good = _drive()
    odd = [
        {"at": "not a time", "lat": -27.5, "lon": 153.0},
        {"at": T0.isoformat(), "lat": 127.5, "lon": 153.0},
        {"lat": -27.5, "lon": 153.0},
        {"at": (datetime.now(timezone.utc) + timedelta(days=4000)).isoformat(), "lat": -27.5, "lon": 153.0},
    ]
    # Kept, without the part that made no sense.
    quirks = [
        {**_p(200, -27.3, 153.2), "accuracy": -1, "speed": "fast"},
        {**_p(201, -27.3, 153.2), "accuracy": None, "speed": -3.0},
    ]
    r = await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": good[:5] + odd + good[5:] + quirks})
    assert r.status_code == 200, r.text
    assert r.json() == {"saved": len(good) + 2, "skipped": 4, "timeline_on": True}

    from app.database import SessionLocal
    from app.maps.models import MapTrackPoint
    from sqlalchemy import select

    async with SessionLocal() as s:
        rows = (await s.execute(select(MapTrackPoint).where(MapTrackPoint.user_id == user.id, MapTrackPoint.lat == -27.3))).scalars().all()
    assert len(rows) == 2 and all(row.accuracy is None and row.speed is None for row in rows)


async def test_a_big_batch_goes_in(user, client):
    """More rows than one INSERT can carry (seven values each)."""
    await _turn_on(client, user)
    points = [{"at": (T0 + timedelta(seconds=i)).isoformat(), "lat": -27.5, "lon": 153.0, "accuracy": 5.0, "speed": 1.0} for i in range(5000)]
    r = await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": points})
    assert r.status_code == 200 and r.json()["saved"] == 5000


async def test_the_server_knows_when_it_last_heard_from_the_phone(db, user, client):
    from app.auth.models import User
    from app.maps import timeline

    # Recording on, and the phone has never been heard from: that's said.
    await _turn_on(client, user)
    got = (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()
    assert got["timeline_on"] and got["phone"]["quiet"] and got["phone"]["seen_at"] is None and got["phone"]["last_point_at"] is None

    # An upload is hearing from it.
    await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": _drive()})
    got = (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()["phone"]
    assert not got["quiet"] and got["seen_at"] and got["points_at"] and got["last_point_at"].startswith("2026-03-10T00:19")

    # So is a check-in, which says how the phone is doing (and never where it is).
    r = await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={"recording": False, "waiting": 412, "problem": "blocked", "app": "1.18.0"})
    assert r.json() == {"timeline_on": True, "sharing": False, "trip": False, "until": None}
    got = (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()["phone"]
    assert got["recording"] is False and got["waiting"] == 412 and got["problem"] == "blocked"
    # A problem it doesn't know the name of isn't kept as words.
    await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={"problem": "at -27.5,153.0"})
    assert (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()["phone"]["problem"] is None

    # Changing a setting doesn't lose what the phone said.
    await client.put("/api/maps/timeline/settings", headers=_hdr(user), json={"retention_days": 90})
    got = (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()
    assert got["retention_days"] == 90 and got["timeline_on"] and got["phone"]["waiting"] == 412

    # Three hours with nothing: quiet again.
    long_ago = datetime.now(timezone.utc) - timeline.PHONE_QUIET - timedelta(minutes=5)
    await timeline.note_phone(db, user.id, seen_at=long_ago, points_at=long_ago)
    await db.commit()
    got = (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()["phone"]
    assert got["quiet"] and got["seen_at"][:16] == long_ago.isoformat()[:16]
    # Nothing about a position is in what's kept.
    row = await db.get(User, user.id, populate_existing=True)
    assert set(row.settings["maps"]["phone"]) <= {"seen_at", "points_at", "recording", "waiting", "problem", "app", "stalled_told"}

    # Paused: nothing to be quiet about.
    await client.put("/api/maps/timeline/settings", headers=_hdr(user), json={"timeline_on": False})
    assert not (await client.get("/api/maps/timeline/settings", headers=_hdr(user))).json()["phone"]["quiet"]


async def test_what_the_phone_said_doesnt_undo_other_settings(db, user, client):
    from app.auth.models import User

    user.settings = {"theme": "dark", "maps": {"timeline_on": True, "retention_days": 30}}
    await db.commit()
    await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={"recording": True})
    row = await db.get(User, user.id, populate_existing=True)
    assert row.settings["theme"] == "dark"
    assert row.settings["maps"]["timeline_on"] is True and row.settings["maps"]["retention_days"] == 30
    assert row.settings["maps"]["phone"]["recording"] is True


async def test_a_day_is_the_viewers_day_when_no_time_zone_is_saved(user, client, no_photon):
    """Without a saved zone a day was cut at midnight UTC: 8 am Tuesday in
    Brisbane showed under Monday. The page now says which zone it's in."""
    await _turn_on(client, user)
    early = datetime(2026, 3, 9, 22, 0, tzinfo=timezone.utc)  # 8 am on the 10th in Brisbane
    points = [{"at": (early + timedelta(minutes=m)).isoformat(), "lat": -27.5 + m * 0.002, "lon": 153.0} for m in range(20)]
    await client.post("/api/maps/timeline/points", headers=_hdr(user), json={"points": points})

    utc = (await client.get("/api/maps/timeline/day", headers=_hdr(user), params={"date": "2026-03-10"})).json()
    assert utc["points"] == 0
    local = (await client.get("/api/maps/timeline/day", headers=_hdr(user), params={"date": "2026-03-10", "tz": "Australia/Brisbane"})).json()
    assert local["points"] == 20 and local["segments"][0]["start"].startswith("2026-03-10T08:00")
    days = (await client.get("/api/maps/timeline/days", headers=_hdr(user), params={"month": "2026-03", "tz": "Australia/Brisbane"})).json()["days"]
    assert days == ["2026-03-10"]
    # A zone that isn't one is ignored, not an error.
    assert (await client.get("/api/maps/timeline/day", headers=_hdr(user), params={"date": "2026-03-10", "tz": "Mars/Olympus"})).status_code == 200


# ---- Live location --------------------------------------------------------------


def test_how_fresh_a_position_is():
    from app.maps.timeline import freshness

    now = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)
    assert freshness(None, now) == (None, "waiting")
    assert freshness(now - timedelta(seconds=40), now) == (40, "fresh")
    assert freshness(now - timedelta(minutes=5), now) == (300, "fresh")
    assert freshness(now - timedelta(minutes=12), now) == (720, "late")
    assert freshness(now - timedelta(minutes=31), now)[1] == "stale"
    # A phone whose clock is ahead isn't "minus two minutes ago".
    assert freshness(now + timedelta(minutes=2), now) == (0, "fresh")


async def test_everyone_sees_how_old_a_shared_position_is(db, user, client):
    from app.maps.models import MapLiveLocation
    from sqlalchemy import update

    friend = await _other(db)
    await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username})
    # Shared, and the phone hasn't sent anything yet: the sharer is told so.
    me = (await client.get("/api/maps/share", headers=_hdr(user))).json()["me"]
    assert me["state"] == "waiting" and me["sent_at"] is None
    # The phone learns of the share when it checks in.
    assert (await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={})).json()["sharing"] is True

    await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})
    live = (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"][0]["live"]
    assert live["state"] == "fresh" and live["age_s"] < 60
    me = (await client.get("/api/maps/share", headers=_hdr(user))).json()["me"]
    assert me["state"] == "fresh" and me["sent_at"]
    # Someone who shares nothing has no "me".
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["me"] is None

    for minutes, state in ((12, "late"), (45, "stale")):
        await db.execute(update(MapLiveLocation).where(MapLiveLocation.user_id == user.id).values(at=datetime.now(timezone.utc) - timedelta(minutes=minutes)))
        await db.commit()
        live = (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"][0]["live"]
        assert live["state"] == state and abs(live["age_s"] - minutes * 60) < 30
        assert (await client.get("/api/maps/share", headers=_hdr(user))).json()["me"]["state"] == state

    # A heartbeat from the same place makes it fresh again.
    await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"][0]["live"]["state"] == "fresh"

    # Stopping still forgets where you were, and the phone is told there's nobody to send to.
    await client.delete(f"/api/maps/share/{friend.id}", headers=_hdr(user))
    assert await db.get(MapLiveLocation, user.id, populate_existing=True) is None
    assert (await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={})).json()["sharing"] is False


async def test_a_share_that_ran_out_is_forgotten_when_the_phone_checks_in(db, user, client):
    from app.maps.models import MapLiveLocation, MapShare
    from sqlalchemy import update

    friend = await _other(db)
    await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username, "hours": 1})
    r = (await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={})).json()
    assert r["sharing"] and r["until"]
    await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})
    await db.execute(update(MapShare).where(MapShare.owner_id == user.id).values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
    await db.commit()
    assert (await client.post("/api/maps/phone/checkin", headers=_hdr(user), json={})).json() == {"timeline_on": False, "sharing": False, "trip": False, "until": None}
    assert await db.get(MapLiveLocation, user.id, populate_existing=True) is None


async def test_someone_sharing_is_told_once_when_their_phone_goes_quiet(db, user, client, told):
    from app.maps import timeline
    from app.maps.models import MapLiveLocation, MapShare
    from sqlalchemy import update

    friend = await _other(db)
    await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username})
    # Starting a share tells your own phone (the push is what wakes it).
    assert len(told) == 1 and told[0]["user_id"] == user.id and friend.username in told[0]["title"] and told[0]["inbox"] is False
    told.clear()

    # Just started: give the phone a chance.
    assert await timeline.live_watch(db) == []
    # Ten minutes on and it never sent anything.
    await db.execute(update(MapShare).where(MapShare.owner_id == user.id).values(created_at=datetime.now(timezone.utc) - timedelta(minutes=11)))
    await db.commit()
    assert await timeline.live_watch(db) == [user.id]
    assert len(told) == 1 and told[0]["user_id"] == user.id and "hasn't started sending" in told[0]["body"]
    # Not again every five minutes.
    assert await timeline.live_watch(db) == [] and len(told) == 1

    # It sends: all's well, and nothing's said.
    await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})
    assert await timeline.live_watch(db) == [] and len(told) == 1

    # Then it stops. Told when, in words, and never where.
    await db.execute(update(MapLiveLocation).where(MapLiveLocation.user_id == user.id).values(at=datetime.now(timezone.utc) - timedelta(minutes=14)))
    await db.commit()
    assert await timeline.live_watch(db) == [user.id]
    assert len(told) == 2 and "stopped sending your location at" in told[1]["body"] and "27.5" not in told[1]["body"]
    assert told[1]["url"] == "/maps?panel=people"
    # The friend was never told anything by this.
    assert all(t["user_id"] == user.id for t in told)

    # Nobody sharing: nobody told.
    await client.delete(f"/api/maps/share/{friend.id}", headers=_hdr(user))
    assert await timeline.live_watch(db) == []


async def test_live_location_never_crosses_a_block(db, user, client):
    from app.people.blocks import UserBlock

    friend = await _other(db)
    await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username})
    await client.post("/api/maps/live", headers=_hdr(user), json={"lat": -27.5, "lon": 153.0})
    assert len((await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"]) == 1
    db.add(UserBlock(blocker_id=user.id, blocked_id=friend.id))
    await db.commit()
    assert (await client.get("/api/maps/share", headers=_hdr(friend))).json()["shared_with_me"] == []
    assert (await client.get("/api/maps/share", headers=_hdr(user))).json()["sharing_with"] == []
    # And a new share with them can't be started.
    assert (await client.put("/api/maps/share", headers=_hdr(user), json={"username": friend.username})).status_code == 404

"""Calls phase 2, WP-D1: voice and video calls in DMs (1:1 and group).
LiveKit is faked (RoomService calls are recorded; webhooks are signed
here), pushes are recorded instead of sent, arq timers are recorded and run
by hand. One file at a time, never two pytest runs at once.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

KEY = "APItestkey"
SECRET = "s3cret-for-tests-0123456789abcdef0123456789"


# ---------------------------------------------------------------- fakes


class FakeLiveKit:
    def __init__(self):
        self.removed: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.data: list = []
        self.participants: dict[str, list[tuple[str, str]]] = {}
        self.down = False

    async def remove_participant(self, room, identity):
        self.removed.append((room, identity))
        return True

    async def delete_room(self, room):
        self.deleted.append(room)
        return True

    async def update_permissions(self, room, identity, *, sources, can_subscribe=True):
        return True

    async def send_data(self, room, payload, *, identities=None, topic=None):
        self.data.append((room, json.loads(payload), list(identities or []), topic))

    async def list_participants(self, room):
        if self.down:
            from app.rtc.service import RtcUnavailable

            raise RtcUnavailable("refused")
        return [SimpleNamespace(identity=i, sid=s, tracks=[]) for i, s in self.participants.get(room, [])]


@pytest.fixture
def lk(monkeypatch):
    from app.config import get_settings
    from app.rtc import service

    monkeypatch.setattr(get_settings(), "LIVEKIT_API_KEY", KEY)
    monkeypatch.setattr(get_settings(), "LIVEKIT_API_SECRET", SECRET)
    fake = FakeLiveKit()
    for name in ("remove_participant", "delete_room", "update_permissions", "send_data", "list_participants"):
        monkeypatch.setattr(service, name, getattr(fake, name))
    return fake


@pytest.fixture
def jobs(monkeypatch):
    """Deferred arq jobs, recorded instead of queued."""
    from app.calls import dm, voice

    got: list[tuple[str, tuple, float]] = []

    async def defer(job, *args, seconds):
        got.append((job, args, seconds))

    monkeypatch.setattr(dm, "_defer", defer)
    monkeypatch.setattr(voice, "_defer", defer)
    return got


@pytest.fixture
def events(monkeypatch):
    """Everything published on the Rooms stream: (recipients, event)."""
    from app.rooms import core

    got: list[tuple[set[str], dict]] = []

    async def publish(user_ids, event):
        got.append(({str(u) for u in user_ids}, json.loads(json.dumps(event, default=str))))

    monkeypatch.setattr(core, "publish", publish)
    return got


@pytest.fixture
def pushes(monkeypatch):
    """Every push a call asked for (notify_user's keyword arguments)."""
    from app.calls import ring

    got: list[dict] = []

    async def notify(**kw):
        got.append(json.loads(json.dumps(kw, default=str)))

    monkeypatch.setattr(ring, "_notify", notify)
    return got


@pytest.fixture
async def client(db, lk, jobs, events, pushes):
    from app import rate_limit
    from app.main import app
    from app.redis_client import redis

    for pattern in ("calls:*", "call:*", "voice:*"):
        for k in await redis.keys(pattern):
            await redis.delete(k)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def make_user(db, name, role="user"):
    from app.auth.models import User

    tag = uuid.uuid4().hex[:6]
    row = User(email=f"{name}{tag}@example.com", username=f"{name}{tag}", password_hash="x", role=role, settings={"timezone": "Australia/Sydney"})
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def H(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def calls_on(db, **kw):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.calls_enabled = True
    for k, v in kw.items():
        setattr(row, k, v)
    await db.commit()


class World:
    pass


async def world(client, db, **kw) -> World:
    """Ann, Ben, Cat and Dan; a 1:1 conversation Ann-Ben, a group of all
    four, and Eve, who's in neither."""
    w = World()
    for n in ("ann", "ben", "cat", "dan", "eve"):
        setattr(w, n, await make_user(db, n))
    await calls_on(db, **kw)
    r = await client.post("/api/rooms/dms", headers=H(w.ann), json={"user_ids": [str(w.ben.id)]})
    assert r.status_code == 200, r.text
    w.dm = r.json()["id"]
    r = await client.post("/api/rooms/dms", headers=H(w.ann), json={"user_ids": [str(w.ben.id), str(w.cat.id), str(w.dan.id)]})
    assert r.status_code == 200, r.text
    w.group = r.json()["id"]
    return w


async def start(client, user, room_id, media="audio", device="web", expect=200):
    r = await client.post("/api/calls", headers=H(user), json={"room_id": room_id, "media": media, "device": device})
    assert r.status_code == expect, r.text
    return r.json()


async def act(client, user, call_id, what, expect=200, **body):
    r = await client.post(f"/api/calls/{call_id}/{what}", headers=H(user), json=body or None)
    assert r.status_code == expect, r.text
    return r.json() if r.content else None


async def call_row(db, call_id):
    from app.calls.models import Call

    return (await db.execute(select(Call).where(Call.id == uuid.UUID(str(call_id))).execution_options(populate_existing=True))).scalar_one()


async def ring_of(db, call_id) -> dict[str, str | None]:
    from app.calls.models import CallParticipant

    rows = (
        await db.execute(
            select(CallParticipant).where(CallParticipant.call_id == uuid.UUID(str(call_id))).execution_options(populate_existing=True)
        )
    ).scalars()
    return {str(p.user_id): p.ring for p in rows}


async def lines(db, room_id):
    """The call lines in a conversation (system messages with meta.call)."""
    from app.rooms.models import RoomMessage

    rows = (
        await db.execute(
            select(RoomMessage).where(RoomMessage.room_id == uuid.UUID(str(room_id)), RoomMessage.kind == "system").order_by(RoomMessage.seq)
        )
    ).scalars().all()
    return [m for m in rows if (m.meta or {}).get("call")]


async def read_seq(db, room_id, user):
    from app.rooms.models import Room, RoomMember

    m = await db.get(RoomMember, (uuid.UUID(str(room_id)), user.id), populate_existing=True)
    r = await db.get(Room, uuid.UUID(str(room_id)), populate_existing=True)
    return m.last_read_seq, r.last_seq


def of_type(events, kind):
    return [(to, e) for to, e in events if e.get("type") == kind]


def kinds(pushes, user=None):
    return [p["extra"]["kind"] for p in pushes if user is None or p["user_id"] == str(user.id)]


def lk_room(call_id):
    return f"c_{uuid.UUID(str(call_id)).hex}"


def ident(user):
    return f"u:{user.id}"


def signed(body: str) -> str:
    from livekit import api

    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    return api.AccessToken(KEY, SECRET).with_sha256(digest).to_jwt()


async def hook(client, event, room, identity="", sid="PA_1"):
    from google.protobuf.json_format import MessageToJson
    from livekit import api

    ev = api.WebhookEvent(event=event, id=f"EV_{uuid.uuid4().hex[:8]}", created_at=int(time.time()))
    ev.room.name = room
    ev.room.sid = "RM_1"
    if identity:
        ev.participant.identity = identity
        ev.participant.sid = sid
        ev.participant.joined_at = int(time.time())
    body = MessageToJson(ev)
    r = await client.post("/api/calls/webhook", content=body, headers={"Authorization": signed(body)})
    assert r.status_code == 200, r.text


async def run_left(jobs, expect=None):
    """Run the latest dropped-connection grace check (WP-D5) now."""
    from app.calls import dm

    job = [j for j in jobs if j[0] == "call_left_check"][-1]
    assert job[2] == dm.LEFT_GRACE
    out = await dm.left_check(*job[1])
    if expect is not None:
        assert out == expect, out
    return out


async def run_timeout(jobs, call_id):
    """Run the latest ring timeout deferred for this call."""
    from app.calls import dm

    job = [j for j in jobs if j[0] == "call_ring_timeout" and j[1][0] == str(call_id)][-1]
    assert job[2] == 45
    return await dm.ring_timeout(*job[1])


# ---------------------------------------------------------------- 1:1: ring, answer, hang up


async def test_ring_answer_and_hang_up(client, db, lk, jobs, events, pushes):
    w = await world(client, db)
    j = await start(client, w.ann, w.dm, media="video")
    call = j["call"]
    cid = call["id"]
    assert call["media"] == "video" and call["group"] is False and call["live"] is True
    assert call["in_call"] == [str(w.ann.id)] and call["ringing"] == [str(w.ben.id)] and call["ring_until"]
    assert j["url"] == "/livekit" and j["lk_room"] == lk_room(cid) and j["identity"] == ident(w.ann)

    from app.rtc import tokens

    claims = tokens.decode(j["token"])
    assert claims["room"] == lk_room(cid) and claims["identity"] == ident(w.ann)
    assert set(claims["sources"]) == {"microphone", "camera", "screen_share", "screen_share_audio"}

    # Ben's devices ring: high urgency, 45 s, tagged so the next push replaces it.
    [p] = pushes
    assert p["user_id"] == str(w.ben.id) and p["category"] == "call" and p["ttl"] == 45 and p["urgency"] == "high"
    assert p["tag"] == f"call:{cid}" and p["actor_user_id"] == str(w.ann.id) and p["inbox"] is False
    assert p["title"] == w.ann.username and p["body"] == "Incoming video call"
    ex = p["extra"]
    assert ex["kind"] == "call_ring" and ex["require_interaction"] is True and ex["answer_token"]
    assert [a["action"] for a in ex["actions"]] == ["call_answer", "call_decline"] and ex["actions"][1]["token"]
    assert ex["answer_url"].endswith(f"?call={cid}&answer=1")
    # ... and so do his open pages; both see the call.
    assert [to for to, _e in of_type(events, "call_ring")] == [{str(w.ben.id)}]
    assert of_type(events, "call_state")[-1][0] == {str(w.ann.id), str(w.ben.id)}
    assert ("call_ring_timeout", (cid, call["started_at"]), 45) in [(a, b, c) for a, b, c in jobs]

    pushes.clear()
    j2 = await act(client, w.ben, cid, "join")
    assert j2["call"]["in_call"] == [str(w.ann.id), str(w.ben.id)] and j2["call"]["answered_at"]
    assert tokens.decode(j2["token"])["identity"] == ident(w.ben)
    # Answering stops the ringing on Ben's other devices.
    assert kinds(pushes) == ["call_stop"] and pushes[0]["extra"]["reason"] == "answered"
    assert of_type(events, "call_ring_stop")[-1] == ({str(w.ben.id)}, {"type": "call_ring_stop", "call_id": cid, "reason": "answered"})
    # The ring timeout then finds nobody ringing.
    assert await run_timeout(jobs, cid) == "nothing"
    assert (await call_row(db, cid)).ended_at is None

    # Twelve minutes later Ann hangs up: a 1:1 call ends for both.
    row = await call_row(db, cid)
    row.answered_at = row.answered_at - timedelta(minutes=12)
    await db.commit()
    r = await act(client, w.ann, cid, "leave")
    assert r["left"] is True
    row = await call_row(db, cid)
    assert row.ended_at is not None and row.ended_reason == "completed"
    assert lk.deleted == [lk_room(cid)]
    [ln] = await lines(db, w.dm)
    assert ln.body == "Video call · 12 min"
    assert ln.meta["call"]["outcome"] == "completed" and ln.meta["call"]["seconds"] >= 720
    assert set(ln.meta["call"]["joined"]) == {str(w.ann.id), str(w.ben.id)}
    # Both were in it: it isn't unread for either.
    for u in (w.ann, w.ben):
        read, last = await read_seq(db, w.dm, u)
        assert read == last
    ended = of_type(events, "call_ended")[-1]
    assert ended[0] == {str(w.ann.id), str(w.ben.id)} and ended[1]["call"]["live"] is False
    assert of_type(events, "message")[-1][1]["message"]["body"] == "Video call · 12 min"
    # Leaving again is a no-op.
    assert (await act(client, w.ben, cid, "leave"))["left"] is False


async def test_decline_ends_a_1to1_call(client, db, lk, events, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    pushes.clear()
    out = await act(client, w.ben, cid, "decline")
    assert out["live"] is False and out["ended_reason"] == "declined"
    assert (await ring_of(db, cid))[str(w.ben.id)] == "declined"
    # Ben's other devices stop ringing; nobody gets "Missed call".
    assert kinds(pushes) == ["call_stop"] and pushes[0]["extra"]["reason"] == "declined"
    [ln] = await lines(db, w.dm)
    assert ln.body == "Missed call" and ln.meta["call"]["declined"] == [str(w.ben.id)]
    assert of_type(events, "call_ended")[-1][1]["call"]["ended_reason"] == "declined"
    await act(client, w.ben, cid, "decline", expect=409)
    await act(client, w.ben, cid, "join", expect=409)


async def test_decline_from_the_push_button(client, db, lk, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    token = pushes[0]["extra"]["actions"][1]["token"]
    r = await client.post("/api/notifications/action", json={"token": token})
    assert r.status_code == 200 and r.json()["message"] == "Call declined"
    assert (await call_row(db, cid)).ended_reason == "declined"
    # A second tap: the call's gone.
    r = await client.post("/api/notifications/action", json={"token": token})
    assert r.status_code == 410
    # The Answer token isn't a button the worker can press.
    r = await client.post("/api/notifications/action", json={"token": pushes[0]["extra"]["answer_token"]})
    assert r.status_code in (401, 410)


async def test_no_answer_is_a_missed_call(client, db, lk, jobs, events, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    pushes.clear()
    assert await run_timeout(jobs, cid) == "missed"
    row = await call_row(db, cid)
    assert row.ended_reason == "missed" and row.answered_at is None
    assert (await ring_of(db, cid))[str(w.ben.id)] == "missed"
    [p] = pushes
    assert p["user_id"] == str(w.ben.id) and p["title"] == "Missed call" and p["body"] == f"{w.ann.username} tried to call you"
    assert p["tag"] == f"call:{cid}" and p["extra"]["kind"] == "call_missed" and p["actor_user_id"] == str(w.ann.id)
    [ln] = await lines(db, w.dm)
    assert ln.body == "Missed call" and ln.meta["call"]["missed"] == [str(w.ben.id)]
    # Unread for Ben (so it shows), read for Ann.
    read, last = await read_seq(db, w.dm, w.ben)
    assert read < last
    read, last = await read_seq(db, w.dm, w.ann)
    assert read == last
    assert ({str(w.ben.id)}, {"type": "call_ring_stop", "call_id": cid, "reason": "missed"}) in events
    # Ann's call ends on her screen too.
    assert of_type(events, "call_ended")[-1][1]["call"]["ended_reason"] == "missed"
    # A late second run changes nothing.
    assert await run_timeout(jobs, cid) == "stale"


async def test_caller_hangs_up_before_an_answer(client, db, lk, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm, media="video"))["call"]["id"]
    pushes.clear()
    await act(client, w.ann, cid, "leave")
    row = await call_row(db, cid)
    assert row.ended_reason == "cancelled"
    assert [(p["user_id"], p["title"]) for p in pushes] == [(str(w.ben.id), "Missed video call")]
    [ln] = await lines(db, w.dm)
    assert ln.body == "Missed video call" and ln.meta["call"]["outcome"] == "cancelled"


async def test_end_for_everyone_and_what_each_side_may_do(client, db, lk):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    # The 1:1 callee pressing End while it rings declines it.
    out = await act(client, w.ben, cid, "end")
    assert out["ended_reason"] == "declined"
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    await act(client, w.ben, cid, "join")
    out = await act(client, w.ben, cid, "end")
    assert out["ended_reason"] == "completed"
    await act(client, w.ann, cid, "end", expect=409)


# ---------------------------------------------------------------- races


async def test_answer_and_cancel_at_the_same_moment(client, db, lk):
    w = await world(client, db)
    for _ in range(3):
        cid = (await start(client, w.ann, w.dm))["call"]["id"]
        a, b = await asyncio.gather(
            client.post(f"/api/calls/{cid}/join", headers=H(w.ben), json={}),
            client.post(f"/api/calls/{cid}/leave", headers=H(w.ann), json={}),
        )
        row = await call_row(db, cid)
        assert row.ended_at is not None
        if a.status_code == 200:
            assert row.ended_reason == "completed"
        else:
            assert a.status_code == 409 and row.ended_reason == "cancelled"
        assert len([ln for ln in await lines(db, w.dm) if ln.meta["call"]["id"] == cid]) == 1


async def test_answer_after_the_timeout_and_the_timeout_after_an_answer(client, db, lk, jobs):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    await run_timeout(jobs, cid)
    r = await client.post(f"/api/calls/{cid}/join", headers=H(w.ben), json={})
    assert r.status_code == 409 and r.json()["detail"] == "This call has ended"

    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    from app.calls import dm

    job = [j for j in jobs if j[0] == "call_ring_timeout" and j[1][0] == cid][-1]
    res, ans = await asyncio.gather(dm.ring_timeout(*job[1]), client.post(f"/api/calls/{cid}/join", headers=H(w.ben), json={}))
    row = await call_row(db, cid)
    if ans.status_code == 200:
        assert res == "nothing" and row.ended_at is None
    else:
        assert res == "missed" and row.ended_reason == "missed"


async def test_both_call_each_other_at_once_and_meet_in_one_call(client, db, lk):
    w = await world(client, db)
    a, b = await asyncio.gather(
        client.post("/api/calls", headers=H(w.ann), json={"room_id": w.dm}),
        client.post("/api/calls", headers=H(w.ben), json={"room_id": w.dm}),
    )
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    assert a.json()["call"]["id"] == b.json()["call"]["id"]
    from app.calls.models import Call

    live = (await db.execute(select(Call).where(Call.room_id == uuid.UUID(w.dm), Call.ended_at.is_(None)))).scalars().all()
    assert len(live) == 1
    row = live[0]
    await db.refresh(row)
    assert row.answered_at is not None
    assert set((await ring_of(db, row.id)).values()) == {"answered"}


async def test_decline_and_answer_from_two_devices_at_once(client, db, lk):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    a, d = await asyncio.gather(
        client.post(f"/api/calls/{cid}/join", headers=H(w.ben), json={}),
        client.post(f"/api/calls/{cid}/decline", headers=H(w.ben)),
    )
    statuses = sorted([a.status_code, d.status_code])
    assert statuses == [200, 409]
    row = await call_row(db, cid)
    if a.status_code == 200:
        assert row.ended_at is None and (await ring_of(db, cid))[str(w.ben.id)] == "answered"
    else:
        assert row.ended_reason == "declined"


async def test_timeout_and_cancel_at_once_leave_one_line(client, db, lk, jobs):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    from app.calls import dm

    job = [j for j in jobs if j[0] == "call_ring_timeout" and j[1][0] == cid][-1]
    await asyncio.gather(dm.ring_timeout(*job[1]), client.post(f"/api/calls/{cid}/leave", headers=H(w.ann), json={}))
    row = await call_row(db, cid)
    assert row.ended_reason in ("missed", "cancelled")
    assert len(await lines(db, w.dm)) == 1


# ---------------------------------------------------------------- group calls


async def test_group_call_rings_everyone_and_anyone_can_join(client, db, lk, jobs, events, pushes):
    w = await world(client, db)
    j = await start(client, w.ann, w.group)
    cid = j["call"]["id"]
    assert j["call"]["group"] is True
    assert set(j["call"]["ringing"]) == {str(w.ben.id), str(w.cat.id), str(w.dan.id)}
    ring = {p["user_id"]: p for p in pushes}
    assert set(ring) == {str(w.ben.id), str(w.cat.id), str(w.dan.id)}
    assert ring[str(w.ben.id)]["body"] == f"{w.ann.username} is starting a call"
    # The group's title is the other members' names.
    assert w.ann.username in ring[str(w.ben.id)]["title"] and w.ben.username not in ring[str(w.ben.id)]["title"]

    await act(client, w.ben, cid, "join")
    out = await act(client, w.cat, cid, "decline")
    assert out["live"] is True  # someone answered: a decline doesn't end it
    pushes.clear()
    assert await run_timeout(jobs, cid) == "missed some"
    assert (await ring_of(db, cid)) == {str(w.ann.id): "answered", str(w.ben.id): "answered", str(w.cat.id): "declined", str(w.dan.id): "missed"}
    assert [(p["user_id"], p["title"], p["extra"]["kind"]) for p in pushes] == [(str(w.dan.id), "Missed call", "call_missed")]
    assert pushes[0]["body"].startswith(f"{w.ann.username} called ")
    assert (await call_row(db, cid)).ended_at is None

    # Dan sees "Call in progress" and joins late; Cat too.
    live = (await client.get("/api/calls/live", headers=H(w.dan))).json()
    assert [c["id"] for c in live["calls"]] == [cid] and live["in_call"] is None
    boot = (await client.get("/api/rooms/bootstrap", headers=H(w.dan))).json()
    assert [c["id"] for c in boot["calls"]] == [cid]
    await act(client, w.dan, cid, "join")
    await act(client, w.cat, cid, "join")
    assert (await ring_of(db, cid))[str(w.dan.id)] == "answered"

    # The starter leaving doesn't end a group call; nor does anyone but the last.
    await act(client, w.ann, cid, "leave")
    await act(client, w.cat, cid, "leave")
    await act(client, w.ben, cid, "leave")
    assert (await call_row(db, cid)).ended_at is None
    # Dan is alone: two minutes later it ends.
    from app.calls import dm

    job = [j for j in jobs if j[0] == "call_alone_check"][-1]
    assert job[2] == 120
    assert await dm.alone_check(*job[1]) == "ended"
    row = await call_row(db, cid)
    assert row.ended_reason == "completed"
    [ln] = await lines(db, w.group)
    assert ln.body.startswith("Call · ")
    assert set(ln.meta["call"]["joined"]) == {str(u.id) for u in (w.ann, w.ben, w.cat, w.dan)}


async def test_group_alone_timer_is_stale_when_someone_comes_back(client, db, lk, jobs):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, cid, "join")
    await act(client, w.ben, cid, "leave")
    job = [j for j in jobs if j[0] == "call_alone_check"][-1]
    await act(client, w.cat, cid, "join")
    from app.calls import dm

    assert await dm.alone_check(*job[1]) == "stale"
    assert (await call_row(db, cid)).ended_at is None


async def test_group_everyone_declines_or_the_starter_ends_it(client, db, lk):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, cid, "decline")
    await act(client, w.cat, cid, "decline")
    assert (await call_row(db, cid)).ended_at is None
    await act(client, w.dan, cid, "decline")
    assert (await call_row(db, cid)).ended_reason == "declined"

    cid = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, cid, "join")
    r = await client.post(f"/api/calls/{cid}/end", headers=H(w.ben))
    assert r.status_code == 403 and "started the call" in r.json()["detail"]
    out = await act(client, w.ann, cid, "end")
    assert out["ended_reason"] == "completed" and out["in_call"] == []
    # Cat and Dan were still ringing: they missed it.
    rings = await ring_of(db, cid)
    assert rings[str(w.cat.id)] == "missed" and rings[str(w.dan.id)] == "missed"


async def test_ring_again_in_a_group_call(client, db, lk, jobs, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, cid, "join")
    await run_timeout(jobs, cid)
    pushes.clear()
    # Only someone in the call can ring.
    await act(client, w.cat, cid, "ring", expect=409)
    out = await act(client, w.ben, cid, "ring", user_ids=[str(w.dan.id)])
    assert out["rang"] == [str(w.dan.id)] and str(w.dan.id) in out["ringing"]
    assert kinds(pushes) == ["call_ring"] and pushes[0]["user_id"] == str(w.dan.id)
    # Not again straight away.
    assert (await act(client, w.ben, cid, "ring", user_ids=[str(w.dan.id)]))["rang"] == []
    # The earlier ring's timeout doesn't touch the new ring.
    from app.calls import dm

    first = [j for j in jobs if j[0] == "call_ring_timeout"][0]
    assert await dm.ring_timeout(*first[1]) == "nothing"
    assert (await ring_of(db, cid))[str(w.dan.id)] == "ringing"
    assert await run_timeout(jobs, cid) == "missed some"


async def test_a_full_call(client, db, lk):
    w = await world(client, db, calls_max_participants=2)
    cid = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, cid, "join")
    r = await client.post(f"/api/calls/{cid}/join", headers=H(w.cat), json={})
    assert r.status_code == 409 and r.json()["detail"] == "This call is full"


# ---------------------------------------------------------------- blocks (D7)


async def test_blocks_refuse_1to1_calls_both_ways(client, db, lk, pushes):
    from app.people.blocks import block

    w = await world(client, db)
    await block(db, w.ann.id, w.ben.id)
    await db.commit()
    r = await client.post("/api/calls", headers=H(w.ann), json={"room_id": w.dm})
    assert r.status_code == 403 and r.json()["detail"] == "You've blocked this person. Unblock them to call."
    r = await client.post("/api/calls", headers=H(w.ben), json={"room_id": w.dm})
    assert r.status_code == 403 and "block" not in r.json()["detail"].lower()
    assert pushes == []
    # In a group, nobody is rung by someone with a block between them.
    j = await start(client, w.ben, w.group)
    assert str(w.ann.id) not in j["call"]["ringing"] and {p["user_id"] for p in pushes} == {str(w.cat.id), str(w.dan.id)}
    # ... but the group's call is open to everyone in it.
    await act(client, w.ann, j["call"]["id"], "join")


async def test_blocking_mid_call_ends_it_and_a_ringing_call_cant_be_answered(client, db, lk):
    from app.people.blocks import block

    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    await act(client, w.ben, cid, "join")
    r = await client.put(f"/api/people/blocks/{w.ann.id}", headers=H(w.ben))
    assert r.status_code == 200
    assert (await call_row(db, cid)).ended_at is not None
    await client.delete(f"/api/people/blocks/{w.ann.id}", headers=H(w.ben))

    # A block made while it rings (without the hook): answering is refused.
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    await block(db, w.ben.id, w.ann.id)
    await db.commit()
    r = await client.post(f"/api/calls/{cid}/join", headers=H(w.ben), json={})
    assert r.status_code == 403


async def test_a_ring_from_someone_blocked_never_reaches_the_device(db, monkeypatch):
    """The ring is an ordinary push with the caller as its actor, so
    dispatch's central block check drops it."""
    import app.notifications.dispatch as d
    from app.notifications.models import PushSubscription
    from app.people.blocks import block

    sent: list[dict] = []
    monkeypatch.setattr(d, "_send_one", lambda **kw: sent.append(kw))

    async def vapid(db):
        return ("k", "mailto:t@example.com")

    monkeypatch.setattr(d, "_vapid", vapid)
    ann, ben = await make_user(db, "ann"), await make_user(db, "ben")
    db.add(PushSubscription(user_id=ben.id, endpoint=f"https://push.invalid/{ben.id}", p256dh="k", auth="a"))
    await block(db, ben.id, ann.id)
    await db.commit()
    out = await d._dispatch(user_id=ben.id, category="call", actor_user_id=ann.id, payload=d.PushPayload(title="a", body="b", ttl=45, urgency="high"), inbox=False)
    assert out["blocked"] == 1 and sent == []


# ---------------------------------------------------------------- quiet hours never hold a ring


async def test_quiet_hours_never_hold_a_ring_and_it_goes_urgent_with_a_45s_ttl(db, monkeypatch):
    import app.notifications.dispatch as d
    import app.notifications.quiet as q
    from app.notifications.models import PushPreferences, PushSubscription

    assert d.RULES["call"].holdable is False and "call" in d.CATEGORIES
    sent: list[dict] = []
    monkeypatch.setattr(d, "_send_one", lambda **kw: sent.append(kw))

    async def vapid(db):
        return ("k", "mailto:t@example.com")

    monkeypatch.setattr(d, "_vapid", vapid)
    # 23:15 in Sydney, quiet hours 22:00-07:00.
    from zoneinfo import ZoneInfo

    monkeypatch.setattr(q, "_now", lambda: datetime.combine(date(2026, 11, 9), datetime.min.time().replace(hour=23, minute=15), tzinfo=ZoneInfo("Australia/Sydney")).astimezone(timezone.utc))
    ben = await make_user(db, "ben")
    db.add(PushSubscription(user_id=ben.id, endpoint=f"https://push.invalid/{ben.id}", p256dh="k", auth="a"))
    db.add(PushPreferences(user_id=ben.id, quiet_enabled=True))
    await db.commit()

    held = await d._dispatch(user_id=ben.id, category="room_message", payload=d.PushPayload(title="Sam", body="up?"), inbox=False)
    assert held["held"] == 1 and sent == []
    out = await d._dispatch(
        user_id=ben.id, category="call", payload=d.PushPayload(title="Ann", body="Incoming call", tag="call:x", ttl=45, urgency="high"), inbox=False
    )
    assert out["delivered"] == 1 and out["held"] == 0
    [s] = sent
    assert s["ttl"] == 45 and s["urgency"] == "high" and json.loads(s["payload_json"])["tag"] == "call:x"
    # Ordinary pushes keep pywebpush's defaults.
    sent.clear()
    await d._dispatch(user_id=ben.id, category="test", payload=d.PushPayload(title="t", body="b"))
    assert sent[0]["ttl"] is None and sent[0]["urgency"] is None

    # The "Calls" switch in Account > Notifications still turns them off.
    prefs = await db.get(PushPreferences, ben.id)
    prefs.call = False
    await db.commit()
    sent.clear()
    await d._dispatch(user_id=ben.id, category="call", payload=d.PushPayload(title="Ann", body="x", ttl=45, urgency="high"), inbox=False)
    assert sent == []


def test_send_one_passes_ttl_and_urgency_to_webpush(monkeypatch):
    import pywebpush

    import app.notifications.dispatch as d

    got = {}
    monkeypatch.setattr(pywebpush, "webpush", lambda **kw: got.update(kw))
    d._send_one(endpoint="https://e", p256dh="k", auth="a", payload_json="{}", vapid_private_key="v", vapid_contact="c", ttl=45, urgency="high")
    assert got["ttl"] == 45 and got["headers"] == {"Urgency": "high"}
    got.clear()
    d._send_one(endpoint="https://e", p256dh="k", auth="a", payload_json="{}", vapid_private_key="v", vapid_contact="c")
    assert "ttl" not in got and "headers" not in got


async def test_preferences_have_the_calls_switch(client, db):
    w = await world(client, db)
    r = await client.patch("/api/notifications/preferences", headers=H(w.ann), json={"call": False})
    assert r.status_code == 200 and r.json()["call"] is False


# ---------------------------------------------------------------- access


async def test_not_found_for_anyone_who_cant_see(client, db, lk):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    for what in ("join", "decline", "leave", "end", "ring", "view"):
        r = await client.post(f"/api/calls/{cid}/{what}", headers=H(w.cat), json={})
        assert r.status_code == 404, (what, r.text)
    assert (await client.get(f"/api/calls/{cid}", headers=H(w.eve))).status_code == 404
    assert (await client.delete(f"/api/calls/{cid}/history", headers=H(w.eve))).status_code == 404
    assert (await client.post("/api/calls", headers=H(w.eve), json={"room_id": w.dm})).status_code == 404
    assert (await client.get(f"/api/calls/{uuid.uuid4()}", headers=H(w.ann))).status_code == 404
    assert (await client.get(f"/api/calls/{cid}", headers=H(w.ben))).status_code == 200
    # Eve sees no live calls in anyone else's conversations.
    assert (await client.get("/api/calls/live", headers=H(w.eve))).json()["calls"] == []

    # Space rooms aren't called (voice channels are their calls).
    r = await client.post("/api/rooms/spaces", headers=H(w.ann), json={"name": "Family"})
    general = r.json()["room_id"]
    assert (await client.post("/api/calls", headers=H(w.ann), json={"room_id": general})).status_code == 404


async def test_calls_off_for_the_server_or_your_group(client, db, lk):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.groups.models import UserGroup, UserGroupMember

    w = await world(client, db)
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    row.calls_enabled = False
    await db.commit()
    assert (await client.post("/api/calls", headers=H(w.ann), json={"room_id": w.dm})).status_code == 404
    assert (await client.get("/api/calls/live", headers=H(w.ann))).status_code == 404
    assert (await client.get("/api/calls/history", headers=H(w.ann))).status_code == 404

    # On for one group only: Ben isn't in it, so he can't be rung.
    g = UserGroup(name=f"callers{uuid.uuid4().hex[:4]}")
    db.add(g)
    await db.flush()
    db.add(UserGroupMember(group_id=g.id, user_id=w.ann.id))
    db.add(UserGroupMember(group_id=g.id, user_id=w.cat.id))
    row.calls_enabled = True
    row.calls_group_ids = [str(g.id)]
    await db.commit()
    r = await client.post("/api/calls", headers=H(w.ann), json={"room_id": w.dm})
    assert r.status_code == 409 and r.json()["detail"] == f"{w.ben.username} can't take calls right now"
    j = await start(client, w.ann, w.group)
    assert j["call"]["ringing"] == [str(w.cat.id)]
    assert (await client.post(f"/api/calls/{j['call']['id']}/join", headers=H(w.ben), json={})).status_code == 404


async def test_disabled_person_isnt_rung(client, db, lk):
    w = await world(client, db)
    w.ben.disabled = True
    await db.commit()
    r = await client.post("/api/calls", headers=H(w.ann), json={"room_id": w.dm})
    assert r.status_code == 409


# ---------------------------------------------------------------- one conversation at a time, devices


async def test_one_live_conversation_at_a_time(client, db, lk, events):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    await act(client, w.ben, cid, "join")
    # Ann calls the group: she's taken out of the 1:1 call, which ends.
    g = (await start(client, w.ann, w.group))["call"]["id"]
    assert (await call_row(db, cid)).ended_reason == "completed"
    assert any(e.get("type") == "call_disconnected" and e["call_id"] == cid and e["reason"] == "elsewhere" for _to, e in events)

    # A voice channel: joining it hangs up the call; answering a call leaves the channel.
    r = await client.post("/api/rooms/spaces", headers=H(w.ann), json={"name": "Lads"})
    space = r.json()["id"]
    r = await client.post(f"/api/rooms/spaces/{space}/rooms", headers=H(w.ann), json={"name": "Lounge", "kind": "voice"})
    lounge = r.json()["id"]
    r = await client.post(f"/api/rooms/rooms/{lounge}/voice/join", headers=H(w.ann), json={"device": "web"})
    assert r.status_code == 200, r.text
    assert (await call_row(db, g)).ended_reason == "cancelled"
    from app.calls import voice

    assert (await voice.where(w.ann.id))["room_id"] == lounge
    cid = (await start(client, w.ben, w.dm))["call"]["id"]
    await act(client, w.ann, cid, "join")
    assert await voice.where(w.ann.id) is None


async def test_a_second_device_takes_over_and_the_old_ones_leave_is_ignored(client, db, lk, events, jobs):
    w = await world(client, db)
    j = await start(client, w.ann, w.dm)
    cid = j["call"]["id"]
    await act(client, w.ben, cid, "join")
    await hook(client, "participant_joined", lk_room(cid), ident(w.ann), sid="PA_web")
    j2 = await act(client, w.ann, cid, "join", device="android")
    assert j2["session_id"] != j["session_id"] and j2["device"] == "android"
    assert ({str(w.ann.id)}, {"type": "call_disconnected", "call_id": cid, "session": j["session_id"], "reason": "replaced"}) in events
    # LiveKit drops the old connection (same identity): that leave is ignored.
    await hook(client, "participant_left", lk_room(cid), ident(w.ann), sid="PA_web")
    assert (await call_row(db, cid)).ended_at is None
    await hook(client, "participant_joined", lk_room(cid), ident(w.ann), sid="PA_phone")
    # The old page's own "leave" with its session does nothing either.
    assert (await act(client, w.ann, cid, "leave", session=j["session_id"]))["left"] is False
    # The phone's connection going does, once its grace is over (WP-D5).
    await hook(client, "participant_left", lk_room(cid), ident(w.ann), sid="PA_phone")
    assert (await call_row(db, cid)).ended_at is None
    await run_left(jobs, "left")
    assert (await call_row(db, cid)).ended_reason == "completed"
    # ...and the call's room closes, so Ben (an Android phone needs telling) isn't left in it.
    assert lk_room(cid) in lk.deleted


async def test_webhooks_kick_strangers_and_late_connections(client, db, lk, jobs):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    # Ben connecting while only rung (not answered): removed.
    await hook(client, "participant_joined", lk_room(cid), ident(w.ben), sid="PA_b")
    assert (lk_room(cid), ident(w.ben)) in lk.removed
    await hook(client, "participant_joined", lk_room(cid), ident(w.eve), sid="PA_e")
    assert (lk_room(cid), ident(w.eve)) in lk.removed
    # A second connection (:view) only while its person is in the call.
    await hook(client, "participant_joined", lk_room(cid), f"{ident(w.ben)}:view", sid="PA_v")
    assert (lk_room(cid), f"{ident(w.ben)}:view") in lk.removed
    lk.removed.clear()
    await hook(client, "participant_joined", lk_room(cid), f"{ident(w.ann)}:view", sid="PA_v2")
    assert lk.removed == []
    # Ann's connection drops before Ben answered: the call is cancelled.
    await hook(client, "participant_joined", lk_room(cid), ident(w.ann), sid="PA_a")
    await hook(client, "participant_left", lk_room(cid), ident(w.ann), sid="PA_a")
    await run_left(jobs, "left")
    assert (await call_row(db, cid)).ended_reason == "cancelled"


async def test_a_dropped_connection_that_comes_back_keeps_the_call(client, db, lk, jobs):
    """WP-D5: LiveKit's full reconnect (Wi-Fi to mobile data) leaves and
    joins again; the call carries on."""
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    await act(client, w.ben, cid, "join")
    await hook(client, "participant_joined", lk_room(cid), ident(w.ann), sid="PA_1")
    await hook(client, "participant_left", lk_room(cid), ident(w.ann), sid="PA_1")
    await hook(client, "participant_joined", lk_room(cid), ident(w.ann), sid="PA_2")
    await run_left(jobs, "back")
    assert (await call_row(db, cid)).ended_at is None
    # Back, but the joined webhook was lost: LiveKit's own list says so.
    await hook(client, "participant_left", lk_room(cid), ident(w.ann), sid="PA_2")
    lk.participants[lk_room(cid)] = [(ident(w.ann), "PA_3")]
    await run_left(jobs, "back")
    assert (await call_row(db, cid)).ended_at is None
    # Gone for good.
    lk.participants[lk_room(cid)] = []
    await run_left(jobs, "left")
    assert (await call_row(db, cid)).ended_reason == "completed"


# ---------------------------------------------------------------- Android: session, push answer, view


async def test_android_session_refresh_and_leave(client, db, lk):
    w = await world(client, db)
    j = await start(client, w.ann, w.dm, device="android")
    cid = j["call"]["id"]
    r = await client.post("/api/calls/session/refresh", json={"session": j["session"]})
    assert r.status_code == 200 and r.json()["session"] == j["session"] and r.json()["lk_room"] == lk_room(cid)
    assert (await client.post("/api/calls/session/refresh", json={"session": "x" * 40})).status_code == 404
    # A newer session (another device) retires this one.
    await act(client, w.ann, cid, "join")
    assert (await client.post("/api/calls/session/refresh", json={"session": j["session"]})).status_code == 404
    assert (await client.post("/api/calls/session/leave", json={"session": j["session"]})).json()["left"] is False

    j = await start(client, w.ben, w.group, device="android")
    r = await client.post("/api/calls/session/leave", json={"session": j["session"]})
    assert r.json()["left"] is True
    assert (await call_row(db, j["call"]["id"])).ended_reason == "cancelled"


async def test_answer_with_the_pushs_token(client, db, lk, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm, media="video"))["call"]["id"]
    token = pushes[0]["extra"]["answer_token"]
    r = await client.post("/api/calls/answer", json={"token": token, "device": "android"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["call"]["id"] == cid and out["device"] == "android" and out["identity"] == ident(w.ben)
    assert (await call_row(db, cid)).answered_at is not None
    # The decline token isn't an answer token; nor is junk.
    assert (await client.post("/api/calls/answer", json={"token": pushes[0]["extra"]["actions"][1]["token"]})).status_code == 404
    assert (await client.post("/api/calls/answer", json={"token": "junk.junk.junk"})).status_code == 404
    # Signed out everywhere: the token dies.
    w.ben.token_version = (w.ben.token_version or 0) + 1
    await db.commit()
    assert (await client.post("/api/calls/answer", json={"token": token})).status_code == 404


async def test_android_ring_state_and_decline_with_the_answer_token(client, db, lk, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    token = pushes[0]["extra"]["answer_token"]
    r = await client.post("/api/calls/answer/state", json={"token": token})
    assert r.status_code == 200 and r.json() == {"ringing": True, "ring": "ringing", "ended": False, "in_call_here": False}
    # Wrong kind of token, junk: 404, never a hint.
    assert (await client.post("/api/calls/answer/state", json={"token": pushes[0]["extra"]["actions"][1]["token"]})).status_code == 404
    assert (await client.post("/api/calls/answer/decline", json={"token": "junk.junk.junk"})).status_code == 404
    r = await client.post("/api/calls/answer/decline", json={"token": token})
    assert r.status_code == 200, r.text
    row = await call_row(db, cid)
    assert row.ended_at is not None and row.ended_reason == "declined"
    r = await client.post("/api/calls/answer/state", json={"token": token})
    assert r.json()["ringing"] is False and r.json()["ended"] is True and r.json()["ring"] == "declined"
    # Declining twice: the call isn't ringing any more.
    assert (await client.post("/api/calls/answer/decline", json={"token": token})).status_code == 409

    # Answered on another device: this one's ring is over.
    pushes.clear()
    g = (await start(client, w.ann, w.dm))["call"]["id"]
    token = next(p for p in pushes if p["extra"].get("kind") == "call_ring")["extra"]["answer_token"]
    await act(client, w.ben, g, "join")
    out = (await client.post("/api/calls/answer/state", json={"token": token})).json()
    assert out["ringing"] is False and out["ended"] is False and out["in_call_here"] is True


async def test_the_page_controls_the_phones_call(client, db, lk):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm, device="android"))["call"]["id"]
    r = await act(client, w.ann, cid, "control", action="mute")
    assert r["delivered"] is True and r["device"] == "android"
    assert lk.data[-1] == (lk_room(cid), {"action": "mute"}, [ident(w.ann)], "call.control")
    # WP-D5: the phone's camera, from the page.
    for action in ("camera_on", "flip", "camera_off"):
        await act(client, w.ann, cid, "control", action=action)
        assert lk.data[-1] == (lk_room(cid), {"action": action}, [ident(w.ann)], "call.control")
    # Not in the call (ringing still), or an unknown action.
    await act(client, w.ben, cid, "control", action="mute", expect=409)
    await act(client, w.ann, cid, "control", action="explode", expect=422)


async def test_view_token_is_listen_only(client, db, lk):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    v = await act(client, w.ann, cid, "view")
    from app.rtc import tokens

    claims = tokens.decode(v["token"])
    assert v["identity"] == f"{ident(w.ann)}:view" and claims["sources"] == [] and claims["can_publish"] is False
    await act(client, w.ben, cid, "view", expect=409)


# ---------------------------------------------------------------- reaper


async def test_reaper(client, db, lk, jobs):
    from app.calls import dm

    w = await world(client, db)
    # A call whose ring timeout was lost.
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    from app.calls.models import CallParticipant

    await db.execute(
        CallParticipant.__table__.update().where(CallParticipant.call_id == uuid.UUID(cid)).values(rung_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    )
    await db.commit()
    stats = await dm.reap()
    assert stats["missed"] == 1 and (await call_row(db, cid)).ended_reason == "missed"

    # Someone in our state but not in LiveKit for a while: gone.
    g = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, g, "join")
    await act(client, w.cat, g, "join")
    lk.participants[lk_room(g)] = [(ident(w.ann), "PA_a"), (ident(w.ben), "PA_b"), (ident(w.eve), "PA_e")]
    await db.execute(
        CallParticipant.__table__.update()
        .where(CallParticipant.call_id == uuid.UUID(g), CallParticipant.in_call_since.is_not(None))
        .values(in_call_since=datetime.now(timezone.utc) - timedelta(minutes=3))
    )
    await db.commit()
    lk.down = True
    await dm.reap()
    assert set((await client.get(f"/api/calls/{g}", headers=H(w.ann))).json()["in_call"]) == {str(w.ann.id), str(w.ben.id), str(w.cat.id)}
    lk.down = False
    await dm.reap()
    assert set((await client.get(f"/api/calls/{g}", headers=H(w.ann))).json()["in_call"]) == {str(w.ann.id), str(w.ben.id)}
    assert (lk_room(g), ident(w.eve)) in lk.removed

    # Calls switched off: live calls end.
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    row.calls_enabled = False
    await db.commit()
    await dm.reap()
    assert (await call_row(db, g)).ended_reason == "ended"


# ---------------------------------------------------------------- history


async def test_history_from_each_side_and_hiding(client, db, lk, jobs):
    w = await world(client, db)
    a = (await start(client, w.ann, w.dm, media="video"))["call"]["id"]
    await run_timeout(jobs, a)  # missed by Ben
    b = (await start(client, w.ben, w.dm))["call"]["id"]
    await act(client, w.ann, b, "join")
    await act(client, w.ann, b, "leave")

    h = (await client.get("/api/calls/history", headers=H(w.ann))).json()
    got = [(c["id"], c["direction"], c["outcome"], c["media"]) for c in h["calls"]]
    assert got == [(b, "incoming", "answered", "audio"), (a, "outgoing", "no_answer", "video")]
    assert str(w.ben.id) in h["users"] and h["calls"][0]["who"] == [str(w.ben.id)] and h["next"] is None
    h = (await client.get("/api/calls/history", headers=H(w.ben))).json()
    assert [(c["direction"], c["outcome"]) for c in h["calls"]] == [("outgoing", "answered"), ("incoming", "missed")]
    # Paging.
    p1 = (await client.get("/api/calls/history?limit=1", headers=H(w.ben))).json()
    assert len(p1["calls"]) == 1 and p1["next"]
    p2 = (await client.get("/api/calls/history", params={"limit": 1, "before": p1["next"]}, headers=H(w.ben))).json()
    assert [c["id"] for c in p2["calls"]] == [a]
    # Hiding is yours alone.
    r = await client.delete(f"/api/calls/{a}/history", headers=H(w.ben))
    assert r.status_code == 204
    assert [c["id"] for c in (await client.get("/api/calls/history", headers=H(w.ben))).json()["calls"]] == [b]
    assert len((await client.get("/api/calls/history", headers=H(w.ann))).json()["calls"]) == 2

    # Export my library: only calls you were in.
    from app.calls.apps import export_sessions

    ex = await export_sessions(db, w.ben.id)
    assert [e["kind"] for e in ex] == ["dm"] and ex[0]["media"] == "audio"


async def test_a_call_reopens_a_closed_conversation(client, db, lk):
    from app.rooms.models import RoomMember

    w = await world(client, db)
    # Ben closed the conversation; Ann's call brings it back for him.
    m = await db.get(RoomMember, (uuid.UUID(w.dm), w.ben.id))
    m.hidden = True
    await db.commit()
    await start(client, w.ann, w.dm)
    m = await db.get(RoomMember, (uuid.UUID(w.dm), w.ben.id), populate_existing=True)
    assert m.hidden is False


# ---------------------------------------------------------------- WP-D4: history, missed calls, the room event, people


async def test_history_is_yours_alone_and_who_you_knew(client, db, lk, jobs):
    from app.people.blocks import block
    from app.rooms.models import RoomMember

    w = await world(client, db)
    g = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, g, "join")
    await run_timeout(jobs, g)  # Cat and Dan missed it
    await act(client, w.ben, g, "leave")
    await act(client, w.ann, g, "leave")
    d = (await start(client, w.ann, w.dm))["call"]["id"]
    await act(client, w.ben, d, "join")
    await act(client, w.ann, d, "leave")

    # Eve was in neither conversation: nothing, and nothing of theirs to remove.
    assert (await client.get("/api/calls/history", headers=H(w.eve))).json()["calls"] == []
    assert (await client.delete(f"/api/calls/{g}/history", headers=H(w.eve))).status_code == 404
    assert (await client.delete(f"/api/calls/{uuid.uuid4()}/history", headers=H(w.eve))).status_code == 404

    def row(h, cid):
        return next(c for c in h["calls"] if c["id"] == cid)

    hb = (await client.get("/api/calls/history", headers=H(w.ben))).json()
    assert [c["id"] for c in hb["calls"]] == [d, g]
    assert set(row(hb, g)["who"]) == {str(w.ann.id), str(w.cat.id), str(w.dan.id)} and row(hb, g)["group"] is True
    assert row(hb, g)["can_call"] is True and row(hb, d)["who"] == [str(w.ann.id)]
    assert {str(w.ann.id), str(w.cat.id), str(w.dan.id)} <= set(hb["users"])
    hc = (await client.get("/api/calls/history", headers=H(w.cat))).json()
    assert [(c["id"], c["direction"], c["outcome"], c["new"]) for c in hc["calls"]] == [(g, "incoming", "missed", True)]

    # Dan leaves the group: his history keeps the call, with the people it
    # rang then (not who's in the group now), and no calling back.
    await db.delete(await db.get(RoomMember, (uuid.UUID(w.group), w.dan.id)))
    await db.commit()
    hd = (await client.get("/api/calls/history", headers=H(w.dan))).json()
    [c] = hd["calls"]
    assert c["id"] == g and set(c["who"]) == {str(w.ann.id), str(w.ben.id), str(w.cat.id)} and c["can_call"] is False
    # ... and he can still remove it.
    assert (await client.delete(f"/api/calls/{g}/history", headers=H(w.dan))).status_code == 204
    assert (await client.get("/api/calls/history", headers=H(w.dan))).json()["calls"] == []
    # Removing it twice is fine.
    assert (await client.delete(f"/api/calls/{g}/history", headers=H(w.dan))).status_code == 204

    # A block in a 1:1: the history stays, calling back doesn't, both ways.
    await block(db, w.ann.id, w.ben.id)
    await db.commit()
    for u in (w.ann, w.ben):
        h = (await client.get("/api/calls/history", headers=H(u))).json()
        assert row(h, d)["can_call"] is False and row(h, g)["can_call"] is True


async def test_removing_and_clearing_only_touch_your_own_history(client, db, lk, jobs):
    w = await world(client, db)
    a = (await start(client, w.ann, w.dm))["call"]["id"]
    await run_timeout(jobs, a)
    b = (await start(client, w.ann, w.dm, media="video"))["call"]["id"]
    await act(client, w.ben, b, "join")
    await act(client, w.ben, b, "leave")

    assert (await client.delete(f"/api/calls/{a}/history", headers=H(w.ann))).status_code == 204
    assert [c["id"] for c in (await client.get("/api/calls/history", headers=H(w.ann))).json()["calls"]] == [b]
    assert [c["id"] for c in (await client.get("/api/calls/history", headers=H(w.ben))).json()["calls"]] == [b, a]

    # Clear: everything ended goes, a live call stays (it's still going).
    live = (await start(client, w.ann, w.group))["call"]["id"]
    assert (await client.delete("/api/calls/history", headers=H(w.ann))).status_code == 204
    assert [c["id"] for c in (await client.get("/api/calls/history", headers=H(w.ann))).json()["calls"]] == [live]
    assert len((await client.get("/api/calls/history", headers=H(w.ben))).json()["calls"]) == 3
    # The other side's line in the conversation is untouched too.
    assert len(await lines(db, w.dm)) == 2


async def test_the_missed_calls_badge(client, db, lk, jobs, events):
    w = await world(client, db)

    async def missed(u):
        r = await client.get("/api/calls/missed", headers=H(u))
        assert r.status_code == 200, r.text
        return r.json()["count"]

    def badge_events(u):
        return [e["count"] for to, e in of_type(events, "calls_missed") if to == {str(u.id)}]

    a = (await start(client, w.ann, w.dm))["call"]["id"]
    await run_timeout(jobs, a)
    b = (await start(client, w.ann, w.dm, media="video"))["call"]["id"]
    await run_timeout(jobs, b)
    assert await missed(w.ben) == 2 and badge_events(w.ben) == [1, 2]
    # A call you made that nobody answered isn't one you missed.
    assert await missed(w.ann) == 0 and badge_events(w.ann) == []
    boot = (await client.get("/api/rooms/bootstrap", headers=H(w.ben))).json()
    assert boot["calls_missed"] == 2
    h = (await client.get("/api/calls/history", headers=H(w.ben))).json()
    assert h["missed"] == 2 and [c["new"] for c in h["calls"]] == [True, True]

    # A call you declined isn't missed either.
    c = (await start(client, w.ann, w.dm))["call"]["id"]
    await act(client, w.ben, c, "decline")
    assert await missed(w.ben) == 2

    # Removing a missed call you haven't seen takes it off the badge.
    events.clear()
    assert (await client.delete(f"/api/calls/{a}/history", headers=H(w.ben))).status_code == 204
    assert await missed(w.ben) == 1 and badge_events(w.ben) == [1]

    # Looking at the Calls tab clears it, on every device (the event).
    events.clear()
    r = await client.post("/api/calls/missed/seen", headers=H(w.ben))
    assert r.status_code == 200 and r.json() == {"count": 0}
    assert badge_events(w.ben) == [0]
    h = (await client.get("/api/calls/history", headers=H(w.ben))).json()
    assert h["missed"] == 0 and all(not c["new"] for c in h["calls"])
    assert next(c for c in h["calls"] if c["id"] == b)["outcome"] == "missed"  # still red, just not new
    # Seen again: nothing changes, nothing is sent.
    events.clear()
    assert (await client.post("/api/calls/missed/seen", headers=H(w.ben))).json() == {"count": 0}
    assert badge_events(w.ben) == []

    # A group call counts for everyone who missed it.
    g = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.cat, g, "join")
    await run_timeout(jobs, g)
    assert await missed(w.ben) == 1 and await missed(w.dan) == 1 and await missed(w.cat) == 0
    await act(client, w.cat, g, "leave")
    await act(client, w.ann, g, "leave")

    # Calling that conversation back counts as seeing its missed calls
    # (the 1:1's own aren't touched).
    d = (await start(client, w.ann, w.dm))["call"]["id"]
    await run_timeout(jobs, d)
    assert await missed(w.ben) == 2
    events.clear()
    back = (await start(client, w.ben, w.dm))["call"]["id"]
    assert await missed(w.ben) == 1 and badge_events(w.ben) == [1]
    await act(client, w.ben, back, "leave")
    # Answering (or joining) a call in a conversation does the same.
    g2 = (await start(client, w.ann, w.group))["call"]["id"]
    await act(client, w.ben, g2, "join")
    assert await missed(w.ben) == 0

    # Calls off for you: no badge to ask about.
    await calls_on(db, calls_enabled=False)
    assert (await client.get("/api/calls/missed", headers=H(w.ben))).status_code == 404


async def test_a_call_sends_the_conversation_to_those_it_reopens(client, db, lk, jobs, events):
    w = await world(client, db)
    # The group was made by Ann and nobody has written in it: closed for the
    # others until something happens in it. A call is something.
    events.clear()
    g = (await start(client, w.ann, w.group))["call"]["id"]
    rooms = of_type(events, "room")
    assert sorted(next(iter(to)) for to, _e in rooms) == sorted(str(u.id) for u in (w.ann, w.ben, w.cat, w.dan))
    for to, e in rooms:
        assert e["room"]["id"] == w.group and e["room"]["hidden"] is False
        assert set(e["room"]["members"]) == {str(u.id) for u in (w.ann, w.ben, w.cat, w.dan)}
        # The names come with it, for a list that never had them.
        assert set(e["users"]) == set(e["room"]["members"])
    # Before the ring, so the page knows where the call is.
    order = [(e["type"], next(iter(to))) for to, e in events if len(to) == 1]
    assert order.index(("room", str(w.ben.id))) < order.index(("call_ring", str(w.ben.id)))

    # Cat closes it mid-call and is rung again: back for her alone.
    await act(client, w.ben, g, "join")
    await run_timeout(jobs, g)
    r = await client.patch(f"/api/rooms/rooms/{w.group}/me", headers=H(w.cat), json={"hidden": True})
    assert r.status_code == 200, r.text
    events.clear()
    out = await act(client, w.ann, g, "ring", user_ids=[str(w.cat.id)])
    assert out["rang"] == [str(w.cat.id)]
    assert [to for to, _e in of_type(events, "room")] == [{str(w.cat.id)}]
    await act(client, w.ann, g, "end")

    # Nothing closed: only the caller's own list hears about it.
    events.clear()
    await start(client, w.ann, w.group)
    assert [to for to, _e in of_type(events, "room")] == [{str(w.ann.id)}]

    # Calling people from Contacts makes a new group: theirs arrives, named.
    events.clear()
    r = await client.post("/api/calls/dm", headers=H(w.ben), json={"user_ids": [str(w.eve.id), str(w.dan.id)], "media": "video"})
    assert r.status_code == 200, r.text
    new_room = r.json()["room_id"]
    got = {next(iter(to)): e for to, e in of_type(events, "room")}
    assert set(got) == {str(w.ben.id), str(w.eve.id), str(w.dan.id)}
    assert all(e["room"]["id"] == new_room for e in got.values())
    assert str(w.ben.id) in got[str(w.eve.id)]["users"]


async def test_people_you_can_call(client, db, lk):
    from app.items import service as items
    from app.people.blocks import block

    w = await world(client, db)
    await items.create_item(db, w.ann, "contacts", installed_check=False, data={
        "contacts": [{"id": "m", "first": "Jane", "last": "Hill", "nickname": "Mum", "promptly_user_id": str(w.cat.id)}],
    })
    await db.commit()

    async def ppl(u, **params):
        r = await client.get("/api/calls/people", params=params, headers=H(u))
        assert r.status_code == 200, r.text
        return r.json()["people"]

    # "Call Mum": by the name you know them by.
    [m] = await ppl(w.ann, q="mum")
    assert m["user"]["id"] == str(w.cat.id) and m["said"] == "Mum" and m["name"] == "Jane Hill"
    assert [p["user"]["id"] for p in await ppl(w.ann, q="jane")] == [str(w.cat.id)]
    # Or by username, anyone on this Promptly.
    assert str(w.ben.id) in [p["user"]["id"] for p in await ppl(w.ann, q=w.ben.username[:5])]
    assert await ppl(w.ann, q="") == []
    # Never yourself.
    assert await ppl(w.ann, q=w.ann.username) == []

    # Blocked people aren't offered, either way round.
    await block(db, w.ann.id, w.dan.id)
    await db.commit()
    assert await ppl(w.ann, q=w.dan.username) == []
    assert await ppl(w.dan, q=w.ann.username) == []
    # ... and a call is refused anyway (without saying why to Dan).
    r = await client.post("/api/calls/dm", headers=H(w.dan), json={"user_ids": [str(w.ann.id)]})
    assert r.status_code == 403 and "block" not in r.json()["detail"].lower()

    # Which of these can I call (Contacts' buttons).
    w.eve.disabled = True
    await db.commit()
    got = await ppl(w.ann, ids=",".join(str(u.id) for u in (w.ann, w.ben, w.dan, w.eve)))
    assert [p["user"]["id"] for p in got] == [str(w.ben.id)]
    assert (await client.get("/api/calls/people", params={"ids": "nope"}, headers=H(w.ann))).status_code == 422

    # The person page says the same.
    assert (await client.get(f"/api/people/u/{w.ben.id}", headers=H(w.ann))).json()["can_call"] is True
    assert (await client.get(f"/api/people/u/{w.dan.id}", headers=H(w.ann))).json()["can_call"] is False
    assert (await client.get(f"/api/people/u/{w.ann.id}", headers=H(w.dan))).json()["can_call"] is False

    # Calls only for a group you're not in: nobody to call, and a 404 for you.
    from app.groups.models import UserGroup

    grp = UserGroup(name=f"callers{uuid.uuid4().hex[:4]}")
    db.add(grp)
    await db.commit()
    await calls_on(db, calls_group_ids=[str(grp.id)])
    assert (await client.get("/api/calls/people", params={"q": "mum"}, headers=H(w.ann))).status_code == 404
    assert (await client.get(f"/api/people/u/{w.ben.id}", headers=H(w.ann))).json()["can_call"] is False


def test_length_words():
    from app.calls.ring import length_words

    assert [length_words(s) for s in (0, 45, 60, 12 * 60 + 5, 3600, 3900)] == ["1 sec", "45 sec", "1 min", "12 min", "1 h", "1 h 5 min"]


# ---------------------------------------------------------------- WP-D5: hand-off, missed-call target, quiet hours


async def test_missed_call_push_opens_that_call_in_the_calls_tab(client, db, lk, jobs, pushes):
    w = await world(client, db)
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    pushes.clear()
    assert await run_timeout(jobs, cid) == "missed"
    [p] = pushes
    assert p["url"] == f"/rooms/calls/{cid}" and p["extra"]["kind"] == "call_missed"


async def test_a_call_started_on_a_phone_hands_off_to_the_app(client, db, lk, jobs):
    """Starting from a phone with the app: the page asks for an Android
    session, the app connects with it; it gets who the call's with, and
    how it ended once it's over."""
    from app.calls import dm

    w = await world(client, db)
    j = await start(client, w.ann, w.dm, device="android")
    cid = j["call"]["id"]
    assert j["title"] == w.ben.username and j["device"] == "android"
    claims = dm.read_session(j["session"])
    assert claims["dev"] == "android" and claims["call"] == cid and claims["sub"] == str(w.ann.id)
    r = await client.post("/api/calls/session/refresh", json={"session": j["session"]})
    assert r.status_code == 200 and r.json()["title"] == w.ben.username and r.json()["call"]["answered_at"] is None
    # Nobody answered: the app hears how it ended.
    assert await run_timeout(jobs, cid) == "missed"
    r = await client.post("/api/calls/session/refresh", json={"session": j["session"]})
    assert r.status_code == 404 and r.json()["detail"] == "ended:missed"

    # Declined.
    j = await start(client, w.ann, w.dm, device="android")
    await act(client, w.ben, j["call"]["id"], "decline")
    r = await client.post("/api/calls/session/refresh", json={"session": j["session"]})
    assert r.status_code == 404 and r.json()["detail"] == "ended:declined"

    # A group's title is its members' names (or its name), not yours.
    j = await start(client, w.ben, w.group, device="android")
    assert w.ben.username not in j["title"] and w.ann.username in j["title"]

    # No app after all (the page takes the call): its join replaces the session.
    j = await start(client, w.cat, w.group, device="android")
    await act(client, w.cat, j["call"]["id"], "join")
    assert (await client.post("/api/calls/session/refresh", json={"session": j["session"]})).status_code == 404


async def _quiet_night(db, monkeypatch, user, hold=False):
    import app.notifications.quiet as q
    from zoneinfo import ZoneInfo

    from app.notifications.models import PushPreferences

    # 23:15 in Sydney; quiet hours 22:00-07:00.
    monkeypatch.setattr(q, "_now", lambda: datetime.combine(date(2026, 11, 9), datetime.min.time().replace(hour=23, minute=15), tzinfo=ZoneInfo("Australia/Sydney")).astimezone(timezone.utc))
    prefs = await db.get(PushPreferences, user.id)
    if prefs is None:
        prefs = PushPreferences(user_id=user.id)
        db.add(prefs)
    prefs.quiet_enabled = True
    prefs.call_quiet_hold = hold
    await db.commit()


async def test_calls_ring_through_quiet_hours_unless_you_hold_them(client, db, lk, jobs, events, pushes, monkeypatch):
    from app.notifications.models import PushHeld

    w = await world(client, db)
    # By default calls always get through quiet hours (the owner's decision).
    await _quiet_night(db, monkeypatch, w.ben)
    pushes.clear()
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    assert kinds(pushes, w.ben) == ["call_ring"]
    assert await run_timeout(jobs, cid) == "missed"
    assert kinds(pushes, w.ben)[-1] == "call_missed"
    assert (await db.execute(select(PushHeld).where(PushHeld.user_id == w.ben.id))).scalars().all() == []

    # "Don't ring me during quiet hours".
    await _quiet_night(db, monkeypatch, w.ben, hold=True)
    pushes.clear()
    events.clear()
    cid = (await start(client, w.ann, w.dm))["call"]["id"]
    # No ring push and no ring on Ben's open pages; it still rings out on the server.
    assert kinds(pushes, w.ben) == []
    assert not [e for to, e in of_type(events, "call_ring") if str(w.ben.id) in {str(x) for x in to}]
    assert (await ring_of(db, cid))[str(w.ben.id)] == "ringing"
    assert await run_timeout(jobs, cid) == "missed"
    # The missed call is held for the morning, pointing at the call.
    assert kinds(pushes, w.ben) == []
    [held] = (await db.execute(select(PushHeld).where(PushHeld.user_id == w.ben.id))).scalars().all()
    assert held.category == "call" and held.reason == "quiet" and held.url == f"/rooms/calls/{cid}" and held.extra["kind"] == "call_missed"
    from app.notifications import quiet

    assert quiet.phrase("call", [held]) == "1 missed call in Calls"

    # Turned off again: they ring.
    await _quiet_night(db, monkeypatch, w.ben, hold=False)
    pushes.clear()
    await start(client, w.ann, w.dm)
    assert kinds(pushes, w.ben) == ["call_ring"]


async def test_preferences_have_the_quiet_hold_switch(client, db):
    w = await world(client, db)
    r = await client.get("/api/notifications/preferences", headers=H(w.ann))
    assert r.status_code == 200 and r.json()["call_quiet_hold"] is False
    r = await client.patch("/api/notifications/preferences", headers=H(w.ann), json={"call_quiet_hold": True})
    assert r.status_code == 200 and r.json()["call_quiet_hold"] is True

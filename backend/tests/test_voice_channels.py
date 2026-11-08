"""Calls WP-V2: voice channels in Rooms. LiveKit is faked (RoomService
calls are recorded; webhooks are signed here); nothing needs a LiveKit
server. One file at a time, never two pytest runs at once.
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

KEY = "APItestkey"
SECRET = "s3cret-for-tests-0123456789abcdef0123456789"


# ---------------------------------------------------------------- fakes


class FakeLiveKit:
    def __init__(self):
        self.removed: list[tuple[str, str]] = []
        self.perms: list[tuple[str, str, list[str], bool]] = []
        self.data: list[tuple[str, dict, list[str], str | None]] = []
        self.participants: dict[str, list[tuple[str, str]]] = {}  # lk room -> [(identity, sid)]
        self.down = False

    async def remove_participant(self, room, identity):
        self.removed.append((room, identity))
        return True

    async def update_permissions(self, room, identity, *, sources, can_subscribe=True):
        self.perms.append((room, identity, list(sources), can_subscribe))
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
    for name in ("remove_participant", "update_permissions", "send_data", "list_participants"):
        monkeypatch.setattr(service, name, getattr(fake, name))
    return fake


@pytest.fixture
def jobs(monkeypatch):
    """Deferred arq jobs, recorded instead of queued."""
    from app.calls import voice

    got: list[tuple[str, tuple, float]] = []

    async def defer(job, *args, seconds):
        got.append((job, args, seconds))

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
async def client(db, lk, jobs, events):
    from app import rate_limit
    from app.main import app
    from app.redis_client import redis

    for pattern in ("calls:*", "voice:*"):
        for k in await redis.keys(pattern):
            await redis.delete(k)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def make_user(db, role="user", name=None):
    from app.auth.models import User

    tag = uuid.uuid4().hex[:8]
    row = User(email=f"{tag}@example.com", username=name or f"u{tag}", password_hash="x", role=role)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def bearer(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def voice_on(db, **kw):
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
    """The Lads: owner, an admin, two members, and someone outside."""


async def world(client, db, **voice_kw) -> World:
    w = World()
    w.owner = await make_user(db, name=f"own{uuid.uuid4().hex[:5]}")
    w.admin = await make_user(db, name=f"adm{uuid.uuid4().hex[:5]}")
    w.sam = await make_user(db, name=f"sam{uuid.uuid4().hex[:5]}")
    w.jo = await make_user(db, name=f"jo{uuid.uuid4().hex[:5]}")
    w.outsider = await make_user(db, name=f"out{uuid.uuid4().hex[:5]}")
    await voice_on(db, **voice_kw)
    r = await client.post("/api/rooms/spaces", headers=bearer(w.owner), json={"name": "The Lads"})
    assert r.status_code == 201, r.text
    w.space = r.json()["id"]
    w.general = r.json()["room_id"]
    r = await client.post(f"/api/rooms/spaces/{w.space}/members", headers=bearer(w.owner), json={"user_ids": [str(w.admin.id), str(w.sam.id), str(w.jo.id)]})
    assert r.status_code == 200
    r = await client.patch(f"/api/rooms/spaces/{w.space}/members/{w.admin.id}", headers=bearer(w.owner), json={"role": "admin"})
    assert r.status_code == 200
    w.lounge = (await new_channel(client, w, "Lounge")).get("id")
    w.games = (await new_channel(client, w, "Games")).get("id")
    return w


async def new_channel(client, w, name):
    r = await client.post(f"/api/rooms/spaces/{w.space}/rooms", headers=bearer(w.owner), json={"name": name, "kind": "voice"})
    assert r.status_code == 201, r.text
    return r.json()


async def join(client, user, room_id, device="web", expect=200):
    r = await client.post(f"/api/rooms/rooms/{room_id}/voice/join", headers=bearer(user), json={"device": device})
    assert r.status_code == expect, r.text
    return r.json()


def lk_room(room_id):
    return f"v_{uuid.UUID(str(room_id)).hex}"


def ident(user):
    return f"u:{user.id}"


async def where(user):
    from app.calls import voice

    return await voice.where(user.id)


async def in_room(room_id):
    from app.calls import voice

    return {m["user_id"]: m for m in await voice.members(room_id)}


def signed(body: str) -> str:
    from livekit import api

    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    return api.AccessToken(KEY, SECRET).with_sha256(digest).to_jwt()


def webhook_body(event: str, room: str, identity: str = "", sid: str = "PA_1", source: int | None = None) -> str:
    from google.protobuf.json_format import MessageToJson
    from livekit import api

    ev = api.WebhookEvent(event=event, id=f"EV_{uuid.uuid4().hex[:8]}", created_at=int(time.time()))
    ev.room.name = room
    ev.room.sid = "RM_1"
    if identity:
        ev.participant.identity = identity
        ev.participant.sid = sid
        ev.participant.joined_at = int(time.time())
    if source is not None:
        ev.track.sid = "TR_1"
        ev.track.source = source
    return MessageToJson(ev)


async def hook(client, *args, **kw):
    body = webhook_body(*args, **kw)
    r = await client.post("/api/calls/webhook", content=body, headers={"Authorization": signed(body)})
    assert r.status_code == 200, r.text


def of_type(events, kind):
    return [(to, e) for to, e in events if e.get("type") == kind]


# ---------------------------------------------------------------- access and permissions


async def test_channels_are_rooms_and_bootstrap_shows_who_is_in(client, db, lk, events):
    w = await world(client, db)
    boot = (await client.get("/api/rooms/bootstrap", headers=bearer(w.sam))).json()
    space = next(s for s in boot["spaces"] if s["id"] == w.space)
    lounge = next(r for r in space["rooms"] if r["id"] == w.lounge)
    assert lounge["kind"] == "voice" and lounge["name"] == "Lounge"
    assert lounge["voice"] == {
        "user_limit": 0, "quality": "good", "bitrate": 64, "join_role": "member",
        "talk_role": "member", "video": True, "alone_minutes": 15,
    }
    assert boot["voice_available"] is True and boot["voice"] == {} and boot["voice_me"] is None

    j = await join(client, w.sam, w.lounge)
    boot = (await client.get("/api/rooms/bootstrap", headers=bearer(w.jo))).json()
    assert [m["user_id"] for m in boot["voice"][w.lounge]] == [str(w.sam.id)]
    me = (await client.get("/api/rooms/bootstrap", headers=bearer(w.sam))).json()["voice_me"]
    assert me["room_id"] == w.lounge and me["session_id"] == j["session_id"] and me["device"] == "web"

    # A voice channel's text chat is the room's normal message list.
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/messages", headers=bearer(w.jo), json={"body": "brb"})
    assert r.status_code == 201

    # Only admins add voice channels; names keep their capitals.
    r = await client.post(f"/api/rooms/spaces/{w.space}/rooms", headers=bearer(w.sam), json={"name": "Mine", "kind": "voice"})
    assert r.status_code == 403
    r = await client.patch(f"/api/rooms/rooms/{w.lounge}", headers=bearer(w.owner), json={"name": "Big  Lounge"})
    assert r.json()["name"] == "Big Lounge"


async def test_not_found_for_anyone_who_cant_see(client, db, lk):
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    x = bearer(w.outsider)
    for method, path, body in (
        ("post", f"/api/rooms/rooms/{w.lounge}/voice/join", {}),
        ("post", f"/api/rooms/rooms/{w.lounge}/voice/view", None),
        ("patch", f"/api/rooms/rooms/{w.lounge}/voice", {"video": False}),
        ("post", f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}", {"server_mute": True}),
        ("post", f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}/move", {"to_room_id": w.games}),
        ("delete", f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}", None),
        ("post", f"/api/rooms/rooms/{uuid.uuid4()}/voice/join", {}),
    ):
        kw = {"headers": x}
        if body is not None:
            kw["json"] = body
        r = await getattr(client, method)(path, **kw)
        assert r.status_code == 404, (path, r.status_code)
    # Things you're not in: 404 as well.
    for path in ("/api/rooms/voice/state", "/api/rooms/voice/still-here", "/api/rooms/voice/control"):
        body = {"action": "mute"} if path.endswith("control") else {}
        assert (await client.post(path, headers=x, json=body)).status_code == 404
    # A text room isn't a voice channel.
    assert (await client.post(f"/api/rooms/rooms/{w.general}/voice/join", headers=bearer(w.sam), json={})).status_code == 404
    assert await where(w.outsider) is None


async def test_voice_off_for_the_server_or_your_group_is_404(client, db, lk):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.groups.models import UserGroup, UserGroupMember

    w = await world(client, db)
    g = UserGroup(name="Family")
    db.add(g)
    await db.commit()
    db.add(UserGroupMember(group_id=g.id, user_id=w.jo.id))
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    row.calls_group_ids = [str(g.id)]
    await db.commit()
    assert (await client.post(f"/api/rooms/rooms/{w.lounge}/voice/join", headers=bearer(w.sam), json={})).status_code == 404
    boot = (await client.get("/api/rooms/bootstrap", headers=bearer(w.sam))).json()
    assert boot["voice_available"] is False and boot["voice"] == {}
    await join(client, w.jo, w.lounge)
    # Sam (no voice) isn't told who's in; Jo and admins are.
    boot = (await client.get("/api/rooms/bootstrap", headers=bearer(w.sam))).json()
    assert boot["voice"] == {}

    row.calls_enabled = False
    await db.commit()
    assert (await client.post(f"/api/rooms/rooms/{w.lounge}/voice/join", headers=bearer(w.jo), json={})).status_code == 404
    assert (await client.post("/api/rooms/voice/leave", headers=bearer(w.jo), json={})).status_code == 404
    # The channel itself still shows, as a room.
    space = next(s for s in (await client.get("/api/rooms/bootstrap", headers=bearer(w.jo))).json()["spaces"] if s["id"] == w.space)
    assert any(r["id"] == w.lounge for r in space["rooms"])


async def test_tokens_carry_exactly_what_you_may_do(client, db, lk):
    import jwt as pyjwt

    from app.rtc import tokens

    w = await world(client, db)
    j = await join(client, w.sam, w.lounge)
    assert j["url"] == "/livekit" and j["identity"] == ident(w.sam) and j["lk_room"] == lk_room(w.lounge)
    assert j["can_talk"] is True and j["can_video"] is True and j["quality"] == "good" and j["bitrate"] == 64
    claims = tokens.decode(j["token"])
    assert claims["room"] == lk_room(w.lounge) and claims["identity"] == ident(w.sam)
    assert claims["sources"] == ["microphone", "camera", "screen_share", "screen_share_audio"]
    assert claims["can_subscribe"] is True
    raw = pyjwt.decode(j["token"], SECRET, algorithms=["HS256"], options={"verify_aud": False})
    assert 9 * 60 <= raw["exp"] - raw["nbf"] <= 11 * 60

    # Admins only talk; video off.
    r = await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"talk_role": "admin"})
    assert r.status_code == 200 and r.json()["talk_role"] == "admin"
    # Sam, already in, lost his microphone in LiveKit too.
    assert (lk_room(w.lounge), ident(w.sam), [], True) in lk.perms
    j = await join(client, w.sam, w.lounge)
    assert j["can_talk"] is False and j["can_video"] is False
    assert tokens.decode(j["token"])["sources"] == [] and tokens.decode(j["token"])["can_publish"] is False
    ja = await join(client, w.admin, w.lounge)
    assert tokens.decode(ja["token"])["sources"][0] == "microphone"

    await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"talk_role": "member", "video": False, "quality": "music"})
    j = await join(client, w.jo, w.lounge)
    assert j["can_talk"] is True and j["can_video"] is False and j["bitrate"] == 128
    assert tokens.decode(j["token"])["sources"] == ["microphone"]
    # A camera report where video is off doesn't stick.
    st = await client.post("/api/rooms/voice/state", headers=bearer(w.jo), json={"video": True, "live": True, "muted": True})
    assert st.json()["video"] is False and st.json()["live"] is False and st.json()["muted"] is True

    # Members can't change channel settings; bad values are refused.
    assert (await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.sam), json={"video": True})).status_code == 403
    assert (await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"user_limit": 1})).status_code == 422
    assert (await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"alone_minutes": 7})).status_code == 422
    assert (await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"quality": "ultra"})).status_code == 422


async def test_admins_only_channel(client, db, lk):
    w = await world(client, db)
    r = await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.owner), json={"join_role": "admin"})
    assert r.status_code == 200
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/join", headers=bearer(w.sam), json={})
    assert r.status_code == 403 and "Only admins" in r.json()["detail"]
    await join(client, w.admin, w.lounge)
    await join(client, w.owner, w.lounge)
    # Turning it on throws out a member who was in.
    await client.patch(f"/api/rooms/rooms/{w.games}/voice", headers=bearer(w.owner), json={"join_role": "member"})
    await join(client, w.jo, w.games)
    await client.patch(f"/api/rooms/rooms/{w.games}/voice", headers=bearer(w.owner), json={"join_role": "admin"})
    assert await where(w.jo) is None and (lk_room(w.games), ident(w.jo)) in lk.removed


# ---------------------------------------------------------------- join, leave, move between channels


async def test_join_leave_and_one_channel_at_a_time(client, db, lk, events):
    from sqlalchemy import select

    from app.calls.models import Call, CallParticipant

    w = await world(client, db)
    events.clear()
    j1 = await join(client, w.sam, w.lounge)
    states = of_type(events, "voice_state")
    assert states and states[-1][1]["room_id"] == w.lounge
    to = states[-1][0]
    # The space's members, never the outsider.
    assert {str(w.owner.id), str(w.admin.id), str(w.sam.id), str(w.jo.id)} == to
    assert [m["user_id"] for m in states[-1][1]["members"]] == [str(w.sam.id)]
    member = states[-1][1]["members"][0]
    assert set(member) == {"user_id", "muted", "deafened", "server_muted", "server_deafened", "video", "live", "watching", "device", "joined_at"}

    # Clicking another channel moves you.
    events.clear()
    j2 = await join(client, w.sam, w.games)
    assert (lk_room(w.lounge), ident(w.sam)) in lk.removed
    assert await in_room(w.lounge) == {} and str(w.sam.id) in await in_room(w.games)
    gone = of_type(events, "voice_disconnected")
    assert gone and gone[0][0] == {str(w.sam.id)} and gone[0][1]["session"] == j1["session_id"] and gone[0][1]["reason"] == "replaced"
    rooms_updated = {e["room_id"] for _, e in of_type(events, "voice_state")}
    assert rooms_updated == {w.lounge, w.games}

    # History: the Lounge session closed when it emptied; Games is open.
    calls = {str(c.room_id): c for c in (await db.execute(select(Call))).scalars()}
    assert calls[w.lounge].ended_at is not None and calls[w.games].ended_at is None
    parts = (await db.execute(select(CallParticipant).where(CallParticipant.user_id == w.sam.id))).scalars().all()
    assert len(parts) == 2 and all(p.display_name == w.sam.username for p in parts)

    # Leave: everyone sees it; a stale session's leave does nothing.
    r = await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={"session": j1["session_id"]})
    assert r.json()["left"] is False and await where(w.sam) is not None
    r = await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={"session": j2["session_id"]})
    assert r.json()["left"] is True and await where(w.sam) is None and await in_room(w.games) == {}
    assert (await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={})).json()["left"] is False


async def test_seconds_are_counted(client, db, lk):
    from sqlalchemy import select

    from app.calls import voice
    from app.calls.models import CallParticipant
    from app.redis_client import redis

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    m = json.loads(await redis.hget(f"voice:r:{w.lounge}", str(w.sam.id)))
    m["joined_at"] = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    await voice._save_member(m)
    await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={})
    p = (await db.execute(select(CallParticipant).where(CallParticipant.user_id == w.sam.id))).scalar_one()
    await db.refresh(p)
    assert 295 <= p.seconds <= 310 and p.last_left_at is not None


async def test_user_limit_and_the_admin_exception(client, db, lk):
    w = await world(client, db)
    r = await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"user_limit": 2})
    assert r.status_code == 200 and r.json()["user_limit"] == 2
    await join(client, w.sam, w.lounge)
    await join(client, w.jo, w.lounge)
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/join", headers=bearer(w.owner), json={})
    assert r.status_code == 200  # owners and admins may go over
    await client.post("/api/rooms/voice/leave", headers=bearer(w.owner), json={})
    # Rejoining (a reload) when full is fine: you're already counted.
    await join(client, w.sam, w.lounge)
    # A third member: full.
    extra = await make_user(db)
    await client.post(f"/api/rooms/spaces/{w.space}/members", headers=bearer(w.owner), json={"user_ids": [str(extra.id)]})
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/join", headers=bearer(extra), json={})
    assert r.status_code == 409 and r.json()["detail"] == "Lounge is full"

    # The server's cap is a hard one, for admins too; channel limits can't exceed it.
    await voice_on(db, calls_max_participants=3)
    await join(client, w.admin, w.lounge)
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/join", headers=bearer(w.owner), json={})
    assert r.status_code == 409
    r = await client.patch(f"/api/rooms/rooms/{w.games}/voice", headers=bearer(w.admin), json={"user_limit": 10})
    assert r.status_code == 400 and "up to 3" in r.json()["detail"]


# ---------------------------------------------------------------- second device, sessions


async def test_second_device_moves_you_and_the_session_refresh(client, db, lk, events):
    from app.rtc import tokens

    w = await world(client, db)
    web = await join(client, w.sam, w.lounge)
    events.clear()
    phone = await join(client, w.sam, w.lounge, device="android")
    # The old connection is removed; the old device is told.
    assert (lk_room(w.lounge), ident(w.sam)) in lk.removed
    gone = of_type(events, "voice_disconnected")
    assert gone[0][1]["session"] == web["session_id"] and gone[0][1]["reason"] == "replaced"
    assert (await in_room(w.lounge))[str(w.sam.id)]["device"] == "android"
    assert (await where(w.sam))["session"] == phone["session_id"]
    # The replaced device's late leave doesn't end the phone's session.
    r = await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={"session": web["session_id"]})
    assert r.json()["left"] is False
    # The same person can join on the phone again with no limit problems.
    assert len(await in_room(w.lounge)) == 1

    # Refresh: the session is the key (no bearer).
    r = await client.post("/api/rooms/voice/refresh", json={"session": phone["session"]})
    assert r.status_code == 200, r.text
    assert tokens.decode(r.json()["token"])["identity"] == ident(w.sam) and r.json()["session"] == phone["session"]
    # Names for the phone's notification ("🔊 Lounge · The Lads").
    assert (r.json()["channel_name"], r.json()["space_name"]) == ("Lounge", "The Lads")
    assert (phone["channel_name"], phone["space_name"]) == ("Lounge", "The Lads")
    # The web session's token no longer works; a forged one never did.
    assert (await client.post("/api/rooms/voice/refresh", json={"session": web["session"]})).status_code == 404
    assert (await client.post("/api/rooms/voice/refresh", json={"session": phone["session"][:-4] + "abcd"})).status_code == 404
    from app.calls import voice

    expired = voice._session_token(w.sam.id, uuid.UUID(w.lounge), phone["session_id"], "android")
    import jwt as pyjwt

    claims = pyjwt.decode(expired, options={"verify_signature": False})
    claims["exp"] = int(time.time()) - 5
    from app.config import get_settings

    stale = pyjwt.encode(claims, get_settings().SECRET_KEY, algorithm="HS256")
    assert (await client.post("/api/rooms/voice/refresh", json={"session": stale})).status_code == 404

    # Removed from the space: out of voice at once, and the session is dead.
    r = await client.delete(f"/api/rooms/spaces/{w.space}/members/{w.sam.id}", headers=bearer(w.owner))
    assert r.status_code == 204
    assert await where(w.sam) is None
    assert (await client.post("/api/rooms/voice/refresh", json={"session": phone["session"]})).status_code == 404


async def raw_sid(room_id, user):
    from app.calls import voice

    return (await voice.raw_members(room_id))[str(user.id)].get("lk_sid")


async def test_a_reload_or_second_device_survives_the_old_connections_late_leave(client, db, lk, events):
    """Rejoining the same channel (a reload, or another device) starts a
    session with no LiveKit sid yet; the old connection's leave arrives
    after it and must not end the new session (phase-1 bug found in D1)."""
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_tab1")
    again = await join(client, w.sam, w.lounge)
    assert (await raw_sid(w.lounge, w.sam)) == ""
    # The old tab's leave (and a late duplicate of its join) come in before
    # the new connection's join: the new session stays.
    await hook(client, "participant_left", lk_room(w.lounge), ident(w.sam), sid="PA_tab1")
    assert (await where(w.sam))["session"] == again["session_id"]
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_tab1")
    assert (await raw_sid(w.lounge, w.sam)) == ""
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_tab2")
    assert (await raw_sid(w.lounge, w.sam)) == "PA_tab2"
    # Same again with the old leave after the new join.
    phone = await join(client, w.sam, w.lounge, device="android")
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_phone")
    await hook(client, "participant_left", lk_room(w.lounge), ident(w.sam), sid="PA_tab2")
    assert (await where(w.sam))["session"] == phone["session_id"]
    # The new connection's own leave still counts.
    await hook(client, "participant_left", lk_room(w.lounge), ident(w.sam), sid="PA_phone")
    assert await where(w.sam) is None and await in_room(w.lounge) == {}


async def test_refresh_refused_after_access_changes(client, db, lk):
    w = await world(client, db)
    phone = await join(client, w.jo, w.lounge, device="android")
    await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"join_role": "admin"})
    assert (await client.post("/api/rooms/voice/refresh", json={"session": phone["session"]})).status_code == 404
    assert await where(w.jo) is None


async def test_remote_control_of_your_own_connection(client, db, lk):
    w = await world(client, db)
    await join(client, w.sam, w.lounge, device="android")
    r = await client.post("/api/rooms/voice/control", headers=bearer(w.sam), json={"action": "deafen"})
    assert r.status_code == 200 and r.json()["delivered"] is True
    assert lk.data[-1] == (lk_room(w.lounge), {"action": "deafen"}, [ident(w.sam)], "voice.control")
    assert (await client.post("/api/rooms/voice/control", headers=bearer(w.sam), json={"action": "explode"})).status_code == 422
    r = await client.post("/api/rooms/voice/control", headers=bearer(w.sam), json={"action": "leave"})
    assert r.status_code == 200 and await where(w.sam) is None
    assert (lk_room(w.lounge), ident(w.sam)) in lk.removed

    # A listen-only view connection only while you're in the channel.
    assert (await client.post(f"/api/rooms/rooms/{w.lounge}/voice/view", headers=bearer(w.sam))).status_code == 404
    await join(client, w.sam, w.lounge, device="android")
    from app.rtc import tokens

    v = (await client.post(f"/api/rooms/rooms/{w.lounge}/voice/view", headers=bearer(w.sam))).json()
    claims = tokens.decode(v["token"])
    assert claims["identity"] == f"{ident(w.sam)}:view" and claims["can_publish"] is False


# ---------------------------------------------------------------- state and speaking


async def test_state_and_speaking_reach_only_the_space(client, db, lk, events):
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    events.clear()
    r = await client.post("/api/rooms/voice/state", headers=bearer(w.sam), json={"deafened": True})
    assert r.status_code == 200 and r.json()["deafened"] is True and r.json()["muted"] is True
    to, ev = of_type(events, "voice_state")[-1]
    assert str(w.outsider.id) not in to and ev["members"][0]["deafened"] is True

    events.clear()
    r = await client.post("/api/rooms/voice/speaking", headers=bearer(w.sam), json={"on": True})
    assert r.status_code == 204
    assert of_type(events, "voice_speaking") == []  # deafened (so muted): no ring
    await client.post("/api/rooms/voice/state", headers=bearer(w.sam), json={"deafened": False, "muted": False})
    events.clear()
    await client.post("/api/rooms/voice/speaking", headers=bearer(w.sam), json={"on": True})
    (to, ev), = of_type(events, "voice_speaking")
    assert ev == {"type": "voice_speaking", "room_id": w.lounge, "user_id": str(w.sam.id), "on": True}
    assert str(w.jo.id) in to and str(w.outsider.id) not in to

    # Not in voice: nothing to say.
    assert (await client.post("/api/rooms/voice/speaking", headers=bearer(w.jo), json={"on": True})).status_code == 404


async def test_speaking_is_rate_limited(client, db, lk, monkeypatch):
    from app.calls import voice

    monkeypatch.setattr(voice, "SPEAKING_LIMIT", (6, 3600))
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    codes = [(await client.post("/api/rooms/voice/speaking", headers=bearer(w.sam), json={"on": i % 2 == 0})).status_code for i in range(8)]
    assert codes == [204] * 6 + [429] * 2


# ---------------------------------------------------------------- moderation


async def test_server_mute_and_deafen_are_enforced_and_stick(client, db, lk, events):
    from app.rtc import tokens

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    url = f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}"
    # Members can't moderate; admins can't moderate the owner.
    assert (await client.post(url, headers=bearer(w.jo), json={"server_mute": True})).status_code == 403
    await join(client, w.owner, w.lounge)
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.owner.id}", headers=bearer(w.admin), json={"server_mute": True})
    assert r.status_code == 403
    assert (await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.outsider.id}", headers=bearer(w.admin), json={"server_mute": True})).status_code == 404

    r = await client.post(url, headers=bearer(w.admin), json={"server_mute": True})
    assert r.status_code == 200 and r.json()["server_muted"] is True
    assert lk.perms[-1] == (lk_room(w.lounge), ident(w.sam), ["camera", "screen_share", "screen_share_audio"], True)
    assert (await in_room(w.lounge))[str(w.sam.id)]["server_muted"] is True
    # His own "unmute" doesn't lift it.
    st = await client.post("/api/rooms/voice/state", headers=bearer(w.sam), json={"muted": False})
    assert st.json()["muted"] is False and st.json()["server_muted"] is True
    # Nor does leaving and coming back.
    await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={})
    j = await join(client, w.sam, w.lounge)
    assert j["server_muted"] is True and "microphone" not in tokens.decode(j["token"])["sources"]

    r = await client.post(url, headers=bearer(w.admin), json={"server_deafen": True})
    assert r.json()["server_deafened"] is True
    assert lk.perms[-1][3] is False  # can't hear anyone
    j = await join(client, w.sam, w.lounge)
    assert tokens.decode(j["token"])["can_subscribe"] is False

    r = await client.post(url, headers=bearer(w.admin), json={"server_mute": False, "server_deafen": False})
    assert r.json() == {"user_id": str(w.sam.id), "server_muted": False, "server_deafened": False}
    assert lk.perms[-1] == (lk_room(w.lounge), ident(w.sam), ["microphone", "camera", "screen_share", "screen_share_audio"], True)
    j = await join(client, w.sam, w.lounge)
    assert tokens.decode(j["token"])["sources"][0] == "microphone"


async def test_move_and_disconnect(client, db, lk, jobs, events):
    from app.calls import voice

    w = await world(client, db)
    await client.patch(f"/api/rooms/rooms/{w.games}/voice", headers=bearer(w.owner), json={"user_limit": 2, "join_role": "admin"})
    await join(client, w.admin, w.games)
    await join(client, w.owner, w.games)
    j = await join(client, w.sam, w.lounge)
    events.clear()
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}/move", headers=bearer(w.admin), json={"to_room_id": w.games})
    assert r.status_code == 200, r.text
    (to, ev), = of_type(events, "voice_moved")
    assert to == {str(w.sam.id)} and ev["to_room_id"] == w.games and ev["by"] == str(w.admin.id) and ev["session"] == j["session_id"]
    job = [x for x in jobs if x[0] == "voice_move_check"][-1]
    assert job[2] == 5
    # He follows: Games is full and admins-only, but a move lets him in.
    await join(client, w.sam, w.games)
    assert str(w.sam.id) in await in_room(w.games)
    assert await voice.move_check(*job[1]) == "moved"
    assert str(w.sam.id) in await in_room(w.games)
    # Without the move, Games still refuses him.
    await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={})
    assert (await client.post(f"/api/rooms/rooms/{w.games}/voice/join", headers=bearer(w.sam), json={})).status_code == 403

    # Moved and doesn't go: removed after the grace period.
    await join(client, w.jo, w.lounge)
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.jo.id}/move", headers=bearer(w.admin), json={"to_room_id": w.games})
    job = [x for x in jobs if x[0] == "voice_move_check"][-1]
    assert await voice.move_check(*job[1]) == "removed"
    assert await where(w.jo) is None and (lk_room(w.lounge), ident(w.jo)) in lk.removed
    # Moving someone who isn't there, or to a text room / another space's channel.
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.jo.id}/move", headers=bearer(w.admin), json={"to_room_id": w.games})
    assert r.status_code == 404
    await join(client, w.jo, w.lounge)
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.jo.id}/move", headers=bearer(w.admin), json={"to_room_id": w.general})
    assert r.status_code == 404

    # Disconnect.
    events.clear()
    r = await client.delete(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.jo.id}", headers=bearer(w.admin))
    assert r.status_code == 204
    assert await where(w.jo) is None and (lk_room(w.lounge), ident(w.jo)) in lk.removed
    (to, ev), = of_type(events, "voice_disconnected")
    assert to == {str(w.jo.id)} and ev["reason"] == "admin" and ev["by"] == str(w.admin.id)
    # His old token can't sneak back in.
    lk.removed.clear()
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.jo), sid="PA_old")
    assert lk.removed == [(lk_room(w.lounge), ident(w.jo))] and await where(w.jo) is None
    # Members can't move or disconnect.
    await join(client, w.jo, w.lounge)
    assert (await client.delete(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.jo.id}", headers=bearer(w.sam))).status_code == 403


async def test_move_of_an_android_session_is_done_by_the_server(client, db, lk, jobs, events):
    from app.calls import voice
    from app.rtc import tokens

    w = await world(client, db)
    await join(client, w.sam, w.lounge, device="android")
    events.clear()
    lk.removed.clear()
    r = await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}/move", headers=bearer(w.admin), json={"to_room_id": w.games})
    assert r.status_code == 200
    cur = await where(w.sam)
    assert cur["room_id"] == w.games and cur["device"] == "android"
    # The service, still in Lounge, gets its new token there; nothing told it to leave.
    room, payload, who, topic = lk.data[-1]
    assert room == lk_room(w.lounge) and who == [ident(w.sam)] and payload["action"] == "move"
    assert tokens.decode(payload["token"])["room"] == lk_room(w.games)
    assert not [d for d in lk.data if d[1].get("action") == "leave"]
    assert lk.removed == []
    (_, ev), = of_type(events, "voice_moved")
    assert ev["handled"] is True
    job = [x for x in jobs if x[0] == "voice_move_check"][-1]
    assert await voice.move_check(*job[1]) == "moved"
    assert (lk_room(w.lounge), ident(w.sam)) in lk.removed


# ---------------------------------------------------------------- alone timeout


async def test_alone_in_a_channel_still_there_then_disconnect(client, db, lk, jobs, events):
    from app.calls import voice

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    alone = [x for x in jobs if x[0] == "voice_alone_check"]
    assert len(alone) == 1 and alone[0][2] == 15 * 60 and alone[0][1][0] == w.lounge
    first = alone[0][1]
    # Someone else arrives: the countdown stops.
    await join(client, w.jo, w.lounge)
    assert await voice.alone_check(*first) == "stale"
    # Jo leaves: Sam's alone again, a new countdown.
    await client.post("/api/rooms/voice/leave", headers=bearer(w.jo), json={})
    second = [x for x in jobs if x[0] == "voice_alone_check"][-1][1]
    assert second != first
    events.clear()
    assert await voice.alone_check(*second) == "asked"
    (to, ev), = of_type(events, "voice_still_there")
    assert to == {str(w.sam.id)} and ev["seconds"] == 120
    ask = [x for x in jobs if x[0] == "voice_alone_check"][-1]
    assert ask[2] == 120
    # "Still here": the old prompt is void and a full countdown starts again.
    r = await client.post("/api/rooms/voice/still-here", headers=bearer(w.sam))
    assert r.status_code == 200
    assert await voice.alone_check(*ask[1]) == "stale"
    again = [x for x in jobs if x[0] == "voice_alone_check"][-1]
    assert again[2] == 15 * 60
    assert await voice.alone_check(*again[1]) == "asked"
    final = [x for x in jobs if x[0] == "voice_alone_check"][-1][1]
    events.clear()
    assert await voice.alone_check(*final) == "disconnected"
    assert await where(w.sam) is None and (lk_room(w.lounge), ident(w.sam)) in lk.removed
    (_, ev), = of_type(events, "voice_disconnected")
    assert ev["reason"] == "alone"


async def test_alone_timeout_per_channel(client, db, lk, jobs):
    w = await world(client, db)
    await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"alone_minutes": None})
    await join(client, w.sam, w.lounge)
    assert not [x for x in jobs if x[0] == "voice_alone_check"]
    r = await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"alone_minutes": 5})
    assert r.json()["alone_minutes"] == 5
    assert [x for x in jobs if x[0] == "voice_alone_check"][-1][2] == 300


# ---------------------------------------------------------------- webhooks


async def test_webhooks_track_connections_cameras_and_streams(client, db, lk, events):
    from sqlalchemy import select

    from app.calls.models import Call

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_sam1")
    events.clear()
    await hook(client, "track_published", lk_room(w.lounge), ident(w.sam), sid="PA_sam1", source=1)  # camera
    assert (await in_room(w.lounge))[str(w.sam.id)]["video"] is True
    await hook(client, "track_published", lk_room(w.lounge), ident(w.sam), sid="PA_sam1", source=3)  # screen share
    assert (await in_room(w.lounge))[str(w.sam.id)]["live"] is True
    assert len(of_type(events, "voice_state")) == 2
    await hook(client, "track_unpublished", lk_room(w.lounge), ident(w.sam), sid="PA_sam1", source=3)
    assert (await in_room(w.lounge))[str(w.sam.id)]["live"] is False
    # Turning video off clears the camera flag.
    await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.admin), json={"video": False})
    assert (await in_room(w.lounge))[str(w.sam.id)]["video"] is False
    await hook(client, "track_published", lk_room(w.lounge), ident(w.sam), sid="PA_sam1", source=1)
    assert (await in_room(w.lounge))[str(w.sam.id)]["video"] is False

    # A leave for some other (older) connection is ignored; his own counts.
    await hook(client, "participant_left", lk_room(w.lounge), ident(w.sam), sid="PA_old")
    assert await where(w.sam) is not None
    await hook(client, "participant_left", lk_room(w.lounge), ident(w.sam), sid="PA_sam1")
    assert await where(w.sam) is None and await in_room(w.lounge) == {}

    # A reconnect after a missed leave: still allowed in, so adopted.
    lk.removed.clear()
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.jo), sid="PA_jo")
    assert (await where(w.jo))["room_id"] == w.lounge and lk.removed == []
    # Someone in another channel showing up here is removed from here.
    await join(client, w.sam, w.games)
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_x")
    assert (lk_room(w.lounge), ident(w.sam)) in lk.removed and (await where(w.sam))["room_id"] == w.games
    # Never a stranger.
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.outsider), sid="PA_y")
    assert (lk_room(w.lounge), ident(w.outsider)) in lk.removed and await where(w.outsider) is None
    # A view connection without its person in the channel is removed.
    await hook(client, "participant_joined", lk_room(w.lounge), f"{ident(w.sam)}:view", sid="PA_v")
    assert (lk_room(w.lounge), f"{ident(w.sam)}:view") in lk.removed

    # LiveKit closed the room: anyone left is out and the session ends.
    await hook(client, "room_finished", lk_room(w.lounge))
    assert await in_room(w.lounge) == {} and await where(w.jo) is None
    lounge_call = (await db.execute(select(Call).where(Call.room_id == uuid.UUID(w.lounge)).order_by(Call.started_at.desc()))).scalars().first()
    await db.refresh(lounge_call)
    assert lounge_call.ended_at is not None


async def test_forged_webhook_changes_nothing(client, db, lk):
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    body = webhook_body("participant_left", lk_room(w.lounge), ident(w.sam), sid="")
    r = await client.post("/api/calls/webhook", content=body, headers={"Authorization": "Bearer forged"})
    assert r.status_code == 401 and await where(w.sam) is not None


async def test_reconnect_reapplies_a_server_mute(client, db, lk):
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.sam.id}", headers=bearer(w.admin), json={"server_mute": True})
    lk.perms.clear()
    await hook(client, "participant_joined", lk_room(w.lounge), ident(w.sam), sid="PA_re")
    assert lk.perms and "microphone" not in lk.perms[-1][2]


# ---------------------------------------------------------------- reaper, deletions


async def test_reaper_reconciles_with_livekit(client, db, lk):
    from app.calls import voice
    from app.redis_client import redis

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await join(client, w.jo, w.lounge)
    # LiveKit down: nothing changes.
    lk.down = True
    await voice.reap()
    assert len(await in_room(w.lounge)) == 2
    lk.down = False
    # Sam is really there; Jo's leave webhook was missed (and he joined a
    # while ago); a stranger connection is there too.
    lk.participants[lk_room(w.lounge)] = [(ident(w.sam), "PA_s"), (ident(w.admin), "PA_a"), (f"{ident(w.sam)}:view", "PA_v")]
    m = json.loads(await redis.hget(f"voice:r:{w.lounge}", str(w.jo.id)))
    m["joined_at"] = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    await voice._save_member(m)
    stats = await voice.reap()
    assert set(await in_room(w.lounge)) == {str(w.sam.id)}
    assert (lk_room(w.lounge), ident(w.admin)) in lk.removed and stats["kicked"] == 1
    # Just joined and not connected yet: left alone.
    await join(client, w.jo, w.lounge)
    await voice.reap()
    assert str(w.jo.id) in await in_room(w.lounge)

    # Voice turned off for the server: everyone is out.
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    row.calls_enabled = False
    await db.commit()
    await voice.reap()
    assert await in_room(w.lounge) == {} and await where(w.sam) is None


async def test_deleting_a_channel_or_space_disconnects(client, db, lk, events):
    from sqlalchemy import select

    from app.calls.models import Call, RoomVoice

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await join(client, w.jo, w.games)
    events.clear()
    assert (await client.delete(f"/api/rooms/rooms/{w.lounge}", headers=bearer(w.owner))).status_code == 204
    assert await where(w.sam) is None and (lk_room(w.lounge), ident(w.sam)) in lk.removed
    assert (await db.execute(select(RoomVoice).where(RoomVoice.room_id == uuid.UUID(w.lounge)))).first() is None
    assert (await client.delete(f"/api/rooms/spaces/{w.space}", headers=bearer(w.owner))).status_code == 204
    assert await where(w.jo) is None
    assert (await db.execute(select(Call))).first() is None  # cascaded with the channels


async def test_demoted_admin_loses_an_admins_only_channel(client, db, lk):
    w = await world(client, db)
    await client.patch(f"/api/rooms/rooms/{w.lounge}/voice", headers=bearer(w.owner), json={"join_role": "admin"})
    await join(client, w.admin, w.lounge)
    r = await client.patch(f"/api/rooms/spaces/{w.space}/members/{w.admin.id}", headers=bearer(w.owner), json={"role": "member"})
    assert r.status_code == 200
    assert await where(w.admin) is None


async def test_blocks_dont_apply_in_space_channels(client, db, lk):
    """Decision D7: a block closes 1:1 conversations, not shared spaces."""
    from app.people import blocks

    w = await world(client, db)
    await blocks.block(db, w.sam.id, w.jo.id)
    await db.commit()
    await join(client, w.sam, w.lounge)
    await join(client, w.jo, w.lounge)
    assert set(await in_room(w.lounge)) == {str(w.sam.id), str(w.jo.id)}


async def test_voice_preferences_follow_you(client, db, lk):
    u = await make_user(db)
    other = str(uuid.uuid4())
    r = await client.patch("/api/auth/me/preferences", headers=bearer(u), json={"voice": {"input_mode": "ptt", "ptt_key": "Backquote", "ptt_release_ms": 200}})
    assert r.status_code == 200, r.text
    r = await client.patch("/api/auth/me/preferences", headers=bearer(u), json={"voice": {"noise": "standard"}, "voice_volumes": {other: 260, "bad": 5}, "voice_local_mutes": [other, other, "x"]})
    s = r.json()["settings"]
    assert s["voice"] == {"input_mode": "ptt", "ptt_key": "Backquote", "ptt_release_ms": 200, "noise": "standard"}
    assert s["voice_volumes"] == {other: 200} and s["voice_local_mutes"] == [other]
    assert (await client.patch("/api/auth/me/preferences", headers=bearer(u), json={"voice": {"noise": "krisp"}})).status_code == 422
    assert (await client.patch("/api/auth/me/preferences", headers=bearer(u), json={"voice": {"ptt_release_ms": 5000}})).status_code == 422


async def test_nothing_reaches_notifications(client, db, lk):
    from sqlalchemy import func, select

    from app.notifications.models import PushHeld

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await join(client, w.jo, w.lounge)
    await client.post(f"/api/rooms/rooms/{w.lounge}/voice/members/{w.jo.id}", headers=bearer(w.admin), json={"server_mute": True})
    assert (await db.execute(select(func.count()).select_from(PushHeld))).scalar() == 0


async def test_go_live_and_who_is_watching(client, db, lk):
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    await join(client, w.jo, w.lounge)
    await join(client, w.admin, w.lounge)
    # Watching someone who isn't live doesn't count.
    r = await client.post("/api/rooms/voice/state", headers=bearer(w.jo), json={"watching": str(w.sam.id)})
    assert r.json()["watching"] is None
    r = await client.post("/api/rooms/voice/state", headers=bearer(w.sam), json={"live": True})
    assert r.json()["live"] is True
    for u in (w.jo, w.admin):
        r = await client.post("/api/rooms/voice/state", headers=bearer(u), json={"watching": str(w.sam.id)})
        assert r.json()["watching"] == str(w.sam.id)
    ms = await in_room(w.lounge)
    assert sum(1 for m in ms.values() if m["watching"] == str(w.sam.id)) == 2
    # Jo stops watching; then Sam ends the stream and nobody's watching.
    r = await client.post("/api/rooms/voice/state", headers=bearer(w.jo), json={"watching": ""})
    assert r.json()["watching"] is None
    await client.post("/api/rooms/voice/state", headers=bearer(w.sam), json={"live": False})
    assert all(m["watching"] is None for m in (await in_room(w.lounge)).values())
    # Live again, watched, then the streamer leaves.
    await client.post("/api/rooms/voice/state", headers=bearer(w.sam), json={"live": True})
    await client.post("/api/rooms/voice/state", headers=bearer(w.admin), json={"watching": str(w.sam.id)})
    await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={})
    assert all(m["watching"] is None for m in (await in_room(w.lounge)).values())


async def test_the_android_service_reports_with_its_session(client, db, lk, events):
    w = await world(client, db)
    phone = await join(client, w.sam, w.lounge, device="android")
    vs = phone["session"]
    r = await client.post("/api/rooms/voice/session/state", json={"voice_session": vs, "muted": True})
    assert r.status_code == 200 and r.json()["muted"] is True
    events.clear()
    r = await client.post("/api/rooms/voice/session/speaking", json={"voice_session": vs, "on": False})
    assert r.status_code == 204 and of_type(events, "voice_speaking")
    assert (await client.post("/api/rooms/voice/session/still-here", json={"voice_session": vs})).status_code == 200
    # Answered on the phone: the question goes away on Sam's other devices.
    assert [to for to, _e in of_type(events, "voice_still_here")] == [{str(w.sam.id)}]
    # A bad or replaced session is refused.
    assert (await client.post("/api/rooms/voice/session/state", json={"voice_session": vs[:-3] + "xyz", "muted": False})).status_code == 404
    web = await join(client, w.sam, w.lounge)
    assert (await client.post("/api/rooms/voice/session/state", json={"voice_session": vs, "muted": False})).status_code == 404
    assert (await client.post("/api/rooms/voice/session/leave", json={"voice_session": vs})).json()["left"] is False
    assert await where(w.sam) is not None
    r = await client.post("/api/rooms/voice/session/leave", json={"voice_session": web["session"]})
    assert r.json()["left"] is True and await where(w.sam) is None


# ---------------------------------------------------------------- WP-V4: the rest of Promptly


async def test_bootstrap_carries_the_servers_voice_limits(client, db, lk):
    w = await world(client, db, calls_max_participants=12, calls_max_stream="1080p30")
    boot = (await client.get("/api/rooms/bootstrap", headers=bearer(w.sam))).json()
    assert boot["voice_limits"] == {"max_participants": 12, "max_stream": "1080p30"}
    await voice_on(db, calls_enabled=False)
    boot = (await client.get("/api/rooms/bootstrap", headers=bearer(w.sam))).json()
    assert boot["voice_available"] is False and boot["voice_limits"] is None


async def test_today_says_who_is_hanging_out(client, db, lk):
    from app.calls.apps import today_section

    w = await world(client, db)
    assert await today_section(db, w.jo) is None
    # Alone in a channel isn't "hanging out" for you; for others it is.
    await join(client, w.sam, w.lounge)
    assert await today_section(db, w.sam) is None
    got = await today_section(db, w.jo)
    (c,) = got["channels"]
    assert c["room_id"] == w.lounge and c["name"] == "Lounge" and c["space"] == "The Lads"
    assert c["people"] == [w.sam.username] and c["here"] is False and got["in_voice"] is None
    await join(client, w.jo, w.lounge)
    got = await today_section(db, w.jo)
    assert got["channels"][0]["here"] is True and got["in_voice"] == w.lounge
    # Someone outside the space sees nothing; voice off for you: nothing.
    assert await today_section(db, w.outsider) is None
    await voice_on(db, calls_enabled=False)
    assert await today_section(db, w.sam) is None


async def test_today_hub_has_the_voice_line(client, db, lk):
    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    r = await client.get("/api/today", headers=bearer(w.jo))
    assert r.status_code == 200, r.text
    v = r.json()["sections"]["voice"]
    assert v["channels"][0]["people"] == [w.sam.username]


async def test_export_has_your_voice_sessions(client, db, lk):
    from app.calls.apps import export_sessions
    from app.calls import voice
    from app.redis_client import redis

    w = await world(client, db)
    await join(client, w.sam, w.lounge)
    m = json.loads(await redis.hget(f"voice:r:{w.lounge}", str(w.sam.id)))
    m["joined_at"] = (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat()
    await voice._save_member(m)
    await client.post("/api/rooms/voice/leave", headers=bearer(w.sam), json={})
    (s,) = await export_sessions(db, w.sam.id)
    assert s["channel"] == "Lounge" and s["space"] == "The Lads" and s["kind"] == "voice"
    assert 2.9 <= s["minutes"] <= 3.2 and s["joined_at"] and s["left_at"]
    assert await export_sessions(db, w.jo.id) == []

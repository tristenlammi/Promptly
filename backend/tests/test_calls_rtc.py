"""Calls WP-V1: LiveKit tokens, signed webhooks, Admin > Calls settings and
checklist, and Test calls. LiveKit itself is faked; nothing here needs a
LiveKit server.
"""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import time
import uuid

import httpx
import pytest

KEY = "APItestkey"
SECRET = "s3cret-for-tests-0123456789abcdef0123456789"


@pytest.fixture
def lk_keys(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "LIVEKIT_API_KEY", KEY)
    monkeypatch.setattr(get_settings(), "LIVEKIT_API_SECRET", SECRET)


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app
    from app.redis_client import redis

    for k in await redis.keys("calls:*"):
        await redis.delete(k)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def make_user(db, role="user"):
    from app.auth.models import User

    tag = uuid.uuid4().hex[:8]
    row = User(email=f"{tag}@example.com", username=f"u{tag}", password_hash="x", role=role)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def bearer(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def signed(body: str, secret: str = SECRET, key: str = KEY) -> str:
    from livekit import api

    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    return api.AccessToken(key, secret).with_sha256(digest).to_jwt()


def event_json(event: str, room: str, identity: str = "u:x", joined_at: int | None = None, created_at: int | None = None) -> str:
    from google.protobuf.json_format import MessageToJson
    from livekit import api

    ev = api.WebhookEvent(event=event, id=f"EV_{uuid.uuid4().hex[:8]}", created_at=created_at or int(time.time()))
    ev.room.name = room
    ev.room.sid = "RM_1"
    if identity:
        ev.participant.identity = identity
        ev.participant.joined_at = joined_at or int(time.time())
    return MessageToJson(ev)


# ---------------------------------------------------------------- names


def test_room_names_and_identities():
    from app.rtc import names

    uid = uuid.uuid4()
    assert names.room_name("v_", uid) == f"v_{uid.hex}"
    assert names.parse(f"t_{uid.hex}") == ("t_", uid.hex)
    assert names.parse("other") is None
    with pytest.raises(ValueError):
        names.room_name("zz_", uid)
    assert names.identity_user(names.user_identity(uid, "echo")) == uid
    assert names.identity_user("agent-1") is None


# ---------------------------------------------------------------- tokens


def test_tokens_carry_exactly_the_grants(lk_keys):
    import jwt as pyjwt

    from app.rtc import tokens

    t = tokens.mint(identity="u:1", room="v_abc", name="Sam", sources=[tokens.MICROPHONE])
    claims = tokens.decode(t)
    assert claims["identity"] == "u:1" and claims["room"] == "v_abc"
    assert claims["sources"] == ["microphone"] and claims["can_publish"] is True
    raw = pyjwt.decode(t, SECRET, algorithms=["HS256"], options={"verify_aud": False})
    assert raw["iss"] == KEY
    assert 9 * 60 <= raw["exp"] - raw["nbf"] <= 11 * 60  # ten minutes

    listen = tokens.decode(tokens.mint(identity="u:1:echo", room="v_abc", sources=[]))
    assert listen["can_publish"] is False and listen["sources"] == [] and listen["can_subscribe"] is True

    deaf = tokens.decode(tokens.mint(identity="u:2", room="v_abc", sources=[tokens.MICROPHONE], can_subscribe=False))
    assert deaf["can_subscribe"] is False


def test_no_tokens_without_keys(monkeypatch):
    from app.config import get_settings
    from app.rtc import config, tokens

    monkeypatch.setattr(get_settings(), "LIVEKIT_API_KEY", "change-me-generate-with-openssl-rand-hex-8")
    monkeypatch.setattr(get_settings(), "LIVEKIT_API_SECRET", "change-me-generate-with-openssl-rand-hex-32")
    assert config.configured() is False
    with pytest.raises(tokens.NotConfigured):
        tokens.mint(identity="u:1", room="v_x", sources=[])


# ---------------------------------------------------------------- webhooks


async def test_webhook_signed_is_accepted_and_counts_usage(client, lk_keys):
    from app.redis_client import redis
    from app.rtc import webhooks

    seen = []

    @webhooks.on("v_")
    async def _spy(ev):
        seen.append((ev.event, ev.room.name))

    try:
        now = int(time.time())
        body = event_json("participant_left", "v_room1", "u:abc", joined_at=now - 600, created_at=now)
        r = await client.post("/api/calls/webhook", content=body, headers={"Authorization": signed(body), "Content-Type": "application/webhook+json"})
        assert r.status_code == 200, r.text
        assert seen == [("participant_left", "v_room1")]
        assert await webhooks.last_heard(redis) is not None
        assert await webhooks.minutes_last_days(redis) == 10

        # A test call's time isn't "time in voice", and its handlers are its own.
        body = event_json("participant_left", "t_room1", "u:abc", joined_at=now - 600, created_at=now)
        r = await client.post("/api/calls/webhook", content=body, headers={"Authorization": signed(body)})
        assert r.status_code == 200
        assert await webhooks.minutes_last_days(redis) == 10
        assert len(seen) == 1
    finally:
        webhooks._handlers["v_"].remove(_spy)


async def test_webhook_forged_or_tampered_is_refused(client, lk_keys):
    from app.redis_client import redis
    from app.rtc import webhooks

    body = event_json("room_started", "v_room1", identity="")
    # Signed with another secret.
    r = await client.post("/api/calls/webhook", content=body, headers={"Authorization": signed(body, secret="x" * 40)})
    assert r.status_code == 401
    # Right secret, different body.
    r = await client.post("/api/calls/webhook", content=body.replace("v_room1", "v_room2"), headers={"Authorization": signed(body)})
    assert r.status_code == 401
    # No signature at all.
    r = await client.post("/api/calls/webhook", content=body)
    assert r.status_code == 401
    assert await webhooks.last_heard(redis) is None


# ---------------------------------------------------------------- settings + access


async def test_admin_settings_and_who_may_use_voice(client, db, lk_keys):
    from app.groups.models import UserGroup, UserGroupMember

    admin = await make_user(db, "admin")
    sam = await make_user(db)
    jo = await make_user(db)

    # Not an admin: no admin routes.
    for path in ("/api/calls/admin/settings", "/api/calls/check", "/api/calls/usage"):
        assert (await client.get(path, headers=bearer(sam))).status_code == 403

    got = (await client.get("/api/calls/admin/settings", headers=bearer(admin))).json()
    assert got == {"enabled": False, "group_ids": None, "max_participants": 30, "max_stream": "1080p60", "configured": True}

    # Off: nobody has voice; Test calls only for the admin.
    me = (await client.get("/api/calls/me", headers=bearer(sam))).json()
    assert me["available"] is False and me["can_test"] is False
    assert (await client.post("/api/calls/test", headers=bearer(sam))).status_code == 404
    assert (await client.get("/api/calls/me", headers=bearer(admin))).json()["can_test"] is True

    r = await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"enabled": True, "max_stream": "720p30", "max_participants": 12})
    assert r.status_code == 200, r.text
    assert r.json()["enabled"] is True and r.json()["max_stream"] == "720p30" and r.json()["max_participants"] == 12
    assert (await client.get("/api/calls/me", headers=bearer(sam))).json()["available"] is True

    # Only one group.
    g = UserGroup(name="Family")
    db.add(g)
    await db.commit()
    db.add(UserGroupMember(group_id=g.id, user_id=jo.id))
    await db.commit()
    r = await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"group_ids": [str(g.id)]})
    assert r.status_code == 200 and r.json()["group_ids"] == [str(g.id)]
    assert (await client.get("/api/calls/me", headers=bearer(sam))).json()["available"] is False
    assert (await client.post("/api/calls/test", headers=bearer(sam))).status_code == 404
    assert (await client.get("/api/calls/me", headers=bearer(jo))).json()["available"] is True
    # Admins always.
    assert (await client.get("/api/calls/me", headers=bearer(admin))).json()["available"] is True

    bad = await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"group_ids": [str(uuid.uuid4())]})
    assert bad.status_code == 400
    assert (await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"max_stream": "4k"})).status_code == 422
    assert (await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"max_participants": 500})).status_code == 422

    r = await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"everyone": True})
    assert r.json()["group_ids"] is None
    assert (await client.get("/api/calls/me", headers=bearer(sam))).json()["available"] is True


async def test_cant_turn_on_without_keys(client, db, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "LIVEKIT_API_KEY", "")
    monkeypatch.setattr(get_settings(), "LIVEKIT_API_SECRET", "")
    admin = await make_user(db, "admin")
    r = await client.patch("/api/calls/admin/settings", headers=bearer(admin), json={"enabled": True})
    assert r.status_code == 409
    me = (await client.get("/api/calls/me", headers=bearer(admin))).json()
    assert me == {"available": False, "can_test": False, "configured": False, "max_stream": "1080p60"}
    assert (await client.post("/api/calls/test", headers=bearer(admin))).status_code == 404


# ---------------------------------------------------------------- test calls


async def test_test_call_tokens_and_report(client, db, lk_keys):
    from app.redis_client import redis
    from app.rtc import tokens

    admin = await make_user(db, "admin")
    r = await client.post("/api/calls/test", headers=bearer(admin))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["url"] == "/livekit" and j["room"] == f"t_{admin.id.hex}"
    me, echo = tokens.decode(j["token"]), tokens.decode(j["echo_token"])
    assert me["identity"] == f"u:{admin.id}:test" and me["sources"] == ["microphone"]
    assert echo["identity"] == f"u:{admin.id}:echo" and echo["can_publish"] is False and echo["room"] == j["room"]

    # From the home network: the report is kept as "inside".
    rep = {"ok": True, "protocol": "udp", "candidate_type": "host", "rtt_ms": 12, "server_address": "81.2.69.9", "download_mbps": 300}
    r = await client.post("/api/calls/test/report", headers={**bearer(admin), "X-Real-IP": "192.168.1.30"}, json=rep)
    assert r.status_code == 200 and r.json() == {"outside": False}
    assert json.loads(await redis.get("calls:test:inside"))["protocol"] == "udp"
    assert await redis.get("calls:test:outside") is None
    assert json.loads(await redis.get("calls:server_ip"))["ip"] == "81.2.69.9"

    bad = await client.post("/api/calls/test/report", headers=bearer(admin), json={"ok": True, "protocol": "sctp"})
    assert bad.status_code == 422


async def test_speedtest_sends_the_bytes_asked(client, db, lk_keys):
    admin = await make_user(db, "admin")
    r = await client.get("/api/calls/speedtest?mb=1", headers=bearer(admin))
    assert r.status_code == 200 and len(r.content) == 1024 * 1024
    assert r.headers["cache-control"] == "no-store"
    assert (await client.get("/api/calls/speedtest?mb=500", headers=bearer(admin))).status_code == 422
    sam = await make_user(db)
    assert (await client.get("/api/calls/speedtest?mb=1", headers=bearer(sam))).status_code == 404


# ---------------------------------------------------------------- checklist + usage


class _Room:
    def __init__(self, name, n):
        self.name, self.num_participants = name, n


async def test_checklist_reflects_reality(client, db, lk_keys, monkeypatch):
    from app.redis_client import redis
    from app.rtc import service, stun

    admin = await make_user(db, "admin")

    async def down():
        raise service.RtcUnavailable("connection refused")

    async def wrong_key():
        raise service.RtcKeyMismatch("401")

    async def rooms():
        return [_Room("v_a", 3), _Room("v_b", 0), _Room("t_c", 2)]

    async def stun_one():
        return [("81.2.69.9", 40000), ("81.2.69.9", 40001)]

    monkeypatch.setattr(stun, "public_addresses", stun_one)

    def by_id(j):
        return {c["id"]: c for c in j["checks"]}

    monkeypatch.setattr(service, "list_rooms", down)
    c = by_id((await client.get("/api/calls/check", headers=bearer(admin))).json())
    assert c["server"]["status"] == "fail" and "isn't answering" in c["server"]["detail"]
    assert c["keys"]["status"] == "unknown"
    assert c["outside"]["status"] == "unknown" and "7882" in c["outside"]["fix"]

    monkeypatch.setattr(service, "list_rooms", wrong_key)
    c = by_id((await client.get("/api/calls/check", headers=bearer(admin))).json())
    assert c["keys"]["status"] == "fail" and "Re-run the installer" in c["keys"]["fix"]

    monkeypatch.setattr(service, "list_rooms", rooms)
    c = by_id((await client.get("/api/calls/check", headers=bearer(admin))).json())
    assert c["server"]["status"] == "ok" and c["keys"]["status"] == "ok"
    assert c["address"]["status"] == "ok" and "81.2.69.9" in c["address"]["detail"]
    assert c["webhooks"]["status"] == "unknown"

    # A test from outside over TCP, with an upload measurement.
    rep = {"ok": True, "protocol": "tcp", "candidate_type": "host", "download_mbps": 20, "server_address": "81.2.69.9"}
    r = await client.post("/api/calls/test/report", headers={**bearer(admin), "X-Real-IP": "93.184.216.34"}, json=rep)
    assert r.json() == {"outside": True}
    c = by_id((await client.get("/api/calls/check", headers=bearer(admin))).json())
    assert c["outside"]["status"] == "warn" and "TCP" in c["outside"]["detail"].upper()
    assert c["upload"]["status"] == "ok" and "2 people can watch a 1080p60" in c["upload"]["detail"]

    # The home's address moved since LiveKit told callers.
    async def stun_moved():
        return [("81.2.69.150", 40000)]

    monkeypatch.setattr(stun, "public_addresses", stun_moved)
    c = by_id((await client.get("/api/calls/check", headers=bearer(admin))).json())
    assert c["address"]["status"] == "warn" and "restart" in c["address"]["fix"].lower()

    # CGNAT.
    async def stun_cgnat():
        return [("100.72.1.2", 1)]

    monkeypatch.setattr(stun, "public_addresses", stun_cgnat)
    c = by_id((await client.get("/api/calls/check", headers=bearer(admin))).json())
    assert c["address"]["status"] == "warn" and "CGNAT" in c["address"]["fix"]

    from app.rtc import metrics

    async def no_metrics():
        return None

    monkeypatch.setattr(metrics, "read", no_metrics)
    u = (await client.get("/api/calls/usage", headers=bearer(admin))).json()
    assert u["running"] is True and u["people_in_voice"] == 3 and u["channels_in_use"] == 1 and u["tests_running"] == 1
    assert u["metrics_available"] is False and u["upload_bps"] is None
    assert await redis.get("calls:test:user:" + str(admin.id)) is not None


async def test_checklist_without_keys_says_how_to_set_up(client, db, monkeypatch):
    from app.config import get_settings
    from app.rtc import stun

    monkeypatch.setattr(get_settings(), "LIVEKIT_API_KEY", "")

    async def none():
        return []

    monkeypatch.setattr(stun, "public_addresses", none)
    admin = await make_user(db, "admin")
    c = {x["id"]: x for x in (await client.get("/api/calls/check", headers=bearer(admin))).json()["checks"]}
    assert c["server"]["status"] == "fail" and "update" in c["server"]["fix"]
    assert c["address"]["status"] == "unknown"


async def test_hourly_check_alerts_once_when_down(db, lk_keys, monkeypatch):
    from app.calls import checks
    from app.redis_client import redis
    from app.rtc import service

    for k in await redis.keys("calls:*"):
        await redis.delete(k)
    sent = []

    async def alert(title, body):
        sent.append(title)

    async def down():
        raise service.RtcUnavailable("refused")

    monkeypatch.setattr(checks, "_alert_admins", alert)
    monkeypatch.setattr(service, "list_rooms", down)
    assert (await checks.hourly(redis, enabled=False)) == {"enabled": False}
    assert sent == []
    await checks.hourly(redis, enabled=True)
    await checks.hourly(redis, enabled=True)
    assert sent == ["Voice channels stopped working"]


# ---------------------------------------------------------------- stun + metrics


def test_stun_response_parsing():
    from app.rtc import stun

    msg, txid = stun._request()
    assert len(msg) == 20 and msg[:2] == b"\x00\x01"
    ip, port = "81.2.69.9", 54321
    xport = port ^ (0x2112A442 >> 16)
    xaddr = int.from_bytes(bytes(map(int, ip.split("."))), "big") ^ 0x2112A442
    attr = struct.pack("!HHBBHI", 0x0020, 8, 0, 1, xport, xaddr)
    resp = struct.pack("!HHI", 0x0101, len(attr), 0x2112A442) + txid + attr
    assert stun.parse_response(resp, txid) == (ip, port)
    assert stun.parse_response(resp, b"x" * 12) is None
    assert stun.is_cgnat("100.64.0.1") and not stun.is_cgnat("8.8.8.8")
    assert stun.is_private("192.168.1.2") and not stun.is_private("81.2.69.9")


def test_metrics_parsing():
    from app.rtc import metrics

    text = """# HELP x
livekit_packet_bytes{direction="incoming",node_id="N",transmission="transmit"} 100
livekit_packet_bytes{direction="outgoing",node_id="N",transmission="transmit"} 2500
livekit_packet_bytes{direction="outgoing",node_id="N",transmission="retransmit"} 500
process_start_time_seconds 1.7e+09
"""
    s = metrics.parse(text)
    assert metrics.bytes_out(s) == 3000
    assert s["process_start_time_seconds"][0][1] == 1.7e9

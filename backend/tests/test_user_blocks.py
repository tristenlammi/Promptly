"""Blocking people (0321, ``app/people/blocks.py``): pushes from a blocked
person dropped centrally (both ways, inbox too), Rooms 1:1 conversations
closed both ways while spaces and group conversations carry on, the blocked
person never told, unblock restoring everything, and every endpoint scoped
to its owner (404, not 403)."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from sqlalchemy import select


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
def _quiet_background(monkeypatch):
    import app.rooms.router as r

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


@pytest.fixture
def sent(monkeypatch):
    import app.notifications.dispatch as d

    out: list[dict] = []

    def fake_send_one(**kw):
        out.append({"endpoint": kw["endpoint"], **json.loads(kw["payload_json"])})

    async def fake_vapid(db):
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "_send_one", fake_send_one)
    monkeypatch.setattr(d, "_vapid", fake_vapid)
    return out


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name: str):
    from app.auth.models import User
    from app.notifications.models import PushSubscription

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}", password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    db.add(PushSubscription(user_id=u.id, endpoint=f"https://push.invalid/{u.username}", p256dh="k", auth="a"))
    await db.commit()
    return u


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


def to(sent, u) -> list[dict]:
    return [p for p in sent if p["endpoint"].endswith(u.username)]


async def block(client, me, other, expect=200):
    r = await client.put(f"/api/people/blocks/{other.id}", headers=H(me))
    assert r.status_code == expect, r.text


async def unblock(client, me, other, expect=200):
    r = await client.delete(f"/api/people/blocks/{other.id}", headers=H(me))
    assert r.status_code == expect, r.text


async def dm(client, me, other):
    return await client.post("/api/rooms/dms", headers=H(me), json={"user_ids": [str(other.id)]})


async def say(client, u, room_id, body="hi"):
    return await client.post(f"/api/rooms/rooms/{room_id}/messages", headers=H(u), json={"body": body})


# ------------------------------------------------------------------ pushes


async def test_dispatch_drops_pushes_from_blocked_people_both_ways(client, db, sent, people):
    from app.notifications.dispatch import PushPayload, _dispatch
    from app.notifications.models import Notification

    ann, bob, cat = people

    async def mention(to_user, actor):
        return await _dispatch(user_id=to_user.id, category="mention", actor_user_id=actor.id,
                               payload=PushPayload(title=f"{actor.username} mentioned you", body="look", category="mention"))

    await block(client, ann, bob)
    # Bob → Ann: dropped, inbox included.
    r = await mention(ann, bob)
    assert r["blocked"] == 1 and to(sent, ann) == []
    # Ann → Bob (Bob was blocked by her): dropped too.
    r = await mention(bob, ann)
    assert r["blocked"] == 1 and to(sent, bob) == []
    assert (await db.execute(select(Notification).where(Notification.user_id.in_([ann.id, bob.id])))).scalars().all() == []
    # Cat is unaffected; nor is anything without an actor.
    assert (await mention(ann, cat))["delivered"] == 1
    r = await _dispatch(user_id=ann.id, category="system_alert", payload=PushPayload(title="Backup failed", body="x"))
    assert r["delivered"] == 1

    # Unblock: back to normal.
    await unblock(client, ann, bob)
    assert (await mention(ann, bob))["delivered"] == 1
    assert (await mention(bob, ann))["delivered"] == 1


async def test_held_push_from_someone_blocked_since_is_dropped(client, db, sent, people, monkeypatch):
    from datetime import datetime, time, timezone

    import app.notifications.quiet as q
    from app.notifications import loops
    from app.notifications.dispatch import PushPayload, _dispatch
    from app.notifications.models import PushPreferences

    ann, bob, cat = people
    db.add(PushPreferences(user_id=ann.id, quiet_enabled=True, quiet_start=time(0, 0), quiet_end=time(23, 59)))
    await db.commit()
    monkeypatch.setattr(q, "_now", lambda: datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc))
    for actor in (bob, cat):
        r = await _dispatch(user_id=ann.id, category="room_message", actor_user_id=actor.id,
                            payload=PushPayload(title=actor.username, body="hey", category="room_message"))
        assert r["held"] == 1
    await block(client, ann, bob)
    pref = await db.get(PushPreferences, ann.id)
    pref.quiet_enabled = False
    await db.commit()
    await loops.run_once(db, datetime(2026, 11, 9, 12, 1, tzinfo=timezone.utc))
    got = to(sent, ann)
    assert len(got) == 1 and got[0]["title"] == cat.username


async def test_room_pushes_dropped_for_blocked_sender_in_a_space(client, db, sent, people, monkeypatch):
    import app.notifications.dispatch as d
    from app.rooms.push import fan_out

    async def notify_now(**kw):  # run the dispatch inline, not as a background task
        payload = d.PushPayload(title=kw.pop("title"), body=kw.pop("body"), url=kw.pop("url", None), tag=kw.pop("tag", None),
                                category=kw["category"], extra=kw.pop("extra", None))
        await d._dispatch(payload=payload, **kw)

    monkeypatch.setattr(d, "notify_user", notify_now)
    ann, bob, cat = people
    r = await client.post("/api/rooms/spaces", headers=H(ann), json={"name": "Family"})
    sid, room = r.json()["id"], r.json()["room_id"]
    await client.post(f"/api/rooms/spaces/{sid}/members", headers=H(ann), json={"user_ids": [str(bob.id), str(cat.id)]})
    await block(client, ann, bob)
    # The space still works for everyone — Bob can post…
    m = await say(client, bob, room, "dinner at 7")
    assert m.status_code == 201
    await fan_out(uuid.UUID(m.json()["id"]))
    # …but Ann gets no push for it; Cat does.
    assert to(sent, ann) == [] and len(to(sent, cat)) == 1
    # And Ann can read it.
    msgs = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()["messages"]
    assert [x["body"] for x in msgs] == ["dinner at 7"]


# ------------------------------------------------------------------ Rooms (D7)


async def test_block_closes_one_to_one_both_ways_and_unblock_restores(client, db, sent, people):
    from app.people.blocks import CANT_SEND, YOU_BLOCKED

    ann, bob, cat = people
    r = await dm(client, ann, bob)
    assert r.status_code == 200
    room = r.json()["id"]
    assert r.json()["can_send"] is True and r.json()["blocked"] is False
    assert (await say(client, ann, room, "hi bob")).status_code == 201

    await block(client, ann, bob)
    # Neither can write in the existing conversation.
    r = await say(client, ann, room)
    assert r.status_code == 403 and r.json()["detail"] == YOU_BLOCKED
    r = await say(client, bob, room)
    assert r.status_code == 403 and r.json()["detail"] == CANT_SEND
    assert "block" not in CANT_SEND.lower()
    # Both can still read it; the flags say who can send — and Bob's never says "blocked".
    boot_a = (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()
    da = next(x for x in boot_a["dms"] if x["id"] == room)
    assert da["blocked"] is True and da["can_send"] is False
    boot_b = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()
    db_ = next(x for x in boot_b["dms"] if x["id"] == room)
    assert db_["blocked"] is False and db_["can_send"] is False
    assert len((await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()["messages"]) == 1
    # Re-opening the existing one is fine (the history stays readable).
    assert (await dm(client, bob, ann)).status_code == 200

    # A new 1:1 can't be started either way.
    from app.rooms.models import Room

    await db.execute(Room.__table__.delete().where(Room.__table__.c.id == uuid.UUID(room)))
    await db.commit()
    r = await dm(client, bob, ann)
    assert r.status_code == 403 and r.json()["detail"] == CANT_SEND
    r = await dm(client, ann, bob)
    assert r.status_code == 403 and r.json()["detail"] == YOU_BLOCKED

    # Group conversations are unchanged.
    r = await client.post("/api/rooms/dms", headers=H(bob), json={"user_ids": [str(ann.id), str(cat.id)]})
    assert r.status_code == 200 and r.json()["kind"] == "group"
    assert (await say(client, bob, r.json()["id"], "group hello")).status_code == 201
    assert (await say(client, ann, r.json()["id"], "hi all")).status_code == 201

    # Unblock: new conversations and messages work again.
    await unblock(client, ann, bob)
    r = await dm(client, bob, ann)
    assert r.status_code == 200 and r.json()["can_send"] is True
    assert (await say(client, bob, r.json()["id"], "hello again")).status_code == 201


async def test_blocked_by_other_side_blocks_both_ways(client, db, sent, people):
    ann, bob, _ = people
    room = (await dm(client, ann, bob)).json()["id"]
    await block(client, bob, ann)  # Bob blocks Ann this time
    assert (await say(client, ann, room)).status_code == 403
    assert (await say(client, bob, room)).status_code == 403
    await unblock(client, bob, ann)
    assert (await say(client, ann, room)).status_code == 201


# ------------------------------------------------------------------ endpoints


async def test_block_endpoints_are_owner_scoped(client, db, people):
    ann, bob, cat = people
    await block(client, ann, bob)
    await block(client, ann, bob)  # idempotent
    rows = (await client.get("/api/people/blocks", headers=H(ann))).json()
    assert [r["id"] for r in rows] == [str(bob.id)] and rows[0]["username"] == bob.username
    # Nobody else sees Ann's list, and Bob isn't told.
    assert (await client.get("/api/people/blocks", headers=H(bob))).json() == []
    assert (await client.get("/api/people/blocks", headers=H(cat))).json() == []
    # Only Ann can undo her block: for anyone else it isn't there (404, not 403).
    await unblock(client, cat, bob, expect=404)
    await unblock(client, bob, ann, expect=404)
    assert len((await client.get("/api/people/blocks", headers=H(ann))).json()) == 1
    # Person pages: Ann sees she blocked Bob; Bob's view of Ann says nothing.
    assert (await client.get(f"/api/people/u/{bob.id}", headers=H(ann))).json()["blocked"] is True
    assert (await client.get(f"/api/people/u/{ann.id}", headers=H(bob))).json()["blocked"] is False
    # Someone who doesn't exist: 404. Yourself: no.
    await block(client, ann, type("X", (), {"id": uuid.uuid4()}), expect=404)
    await block(client, ann, ann, expect=400)
    assert (await client.put(f"/api/people/blocks/{bob.id}")).status_code == 401
    await unblock(client, ann, bob)
    await unblock(client, ann, bob, expect=404)
    assert (await client.get("/api/people/blocks", headers=H(ann))).json() == []

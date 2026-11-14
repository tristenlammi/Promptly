"""Rooms: Sent → Delivered → Seen in conversations, muting for a while, and a
read conversation's notification coming off your phone (``rooms/receipts.py``)."""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_rooms import H, client, make_space, mk_user, people, say  # noqa: F401

NATIVE_NEW = "PromptlyAndroid/1.11.0 (Android; Pixel 9; 0123456789ab)"
NATIVE_OLD = "PromptlyAndroid/1.10.0 (Android; Pixel 7; ba9876543210)"
CHROME = "Mozilla/5.0 (Linux; Android 16; Pixel 9) Mobile"


@pytest.fixture
def sent(monkeypatch):
    import app.notifications.dispatch as d

    out: list[dict] = []

    def fake_send_one(**kw):
        out.append(kw)

    async def fake_vapid(db):
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "_send_one", fake_send_one)
    monkeypatch.setattr(d, "_vapid", fake_vapid)
    return out


@pytest.fixture
def events(monkeypatch):
    """What the live feed was told, as ``(user id, event)``."""
    from app.rooms import core

    out: list[tuple[str, dict]] = []
    real = core.publish

    async def spy(user_ids, event):
        for u in set(str(x) for x in user_ids):
            out.append((u, json.loads(json.dumps(event, default=str))))
        await real(user_ids, event)

    monkeypatch.setattr(core, "publish", spy)
    return out


async def _drain():
    from app import background

    for _ in range(100):
        if background.pending_count() == 0:
            return
        await asyncio.sleep(0.05)


async def _device(db, user, endpoint, agent):
    from app.notifications.models import PushSubscription

    db.add(PushSubscription(user_id=user.id, endpoint=endpoint, p256dh="k", auth="a", user_agent=agent, enabled=True))
    await db.commit()


async def _dm(client, a, *others):
    r = await client.post("/api/rooms/dms", headers=H(a), json={"user_ids": [str(o.id) for o in others]})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _mine(client, u, room_id) -> dict:
    b = (await client.get("/api/rooms/bootstrap", headers=H(u))).json()
    for r in b["dms"] + [r for s in b["spaces"] for r in s["rooms"]]:
        if r["id"] == room_id:
            return r
    raise AssertionError("room not in bootstrap")


# ------------------------------------------------------------------ receipts


async def test_sent_then_delivered_then_seen(client, db, people, events):  # noqa: F811
    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "home by six")
    await _drain()
    events.clear()  # (Ann writing told Bob she's read up to her own message)

    # Nothing of Bob's has it yet.
    assert (await _mine(client, ann, dm))["receipts"] == {str(bob.id): {"read": 0, "delivered": 0}}

    # One of Bob's pages got it on its live feed.
    r = await client.post(f"/api/rooms/rooms/{dm}/delivered", headers=H(bob), json={"seq": m["seq"]})
    assert r.status_code == 204
    assert (await _mine(client, ann, dm))["receipts"][str(bob.id)] == {"read": 0, "delivered": m["seq"]}
    told = [e for u, e in events if e["type"] == "receipt"]
    assert told and told[-1] == {"type": "receipt", "room_id": dm, "user_id": str(bob.id), "read": 0, "delivered": m["seq"]}
    # Ann is told; Bob's own pages aren't (it's not news to him).
    assert {u for u, e in events if e["type"] == "receipt"} == {str(ann.id)}

    # Bob reads it.
    await client.post(f"/api/rooms/rooms/{dm}/read", headers=H(bob), json={"seq": m["seq"]})
    await _drain()
    assert (await _mine(client, ann, dm))["receipts"][str(bob.id)] == {"read": m["seq"], "delivered": m["seq"]}
    assert [e for u, e in events if e["type"] == "receipt"][-1]["read"] == m["seq"]


async def test_loading_the_list_counts_as_delivered(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "are you up?")
    await _drain()
    await client.get("/api/rooms/bootstrap", headers=H(bob))  # Bob opens Rooms: the list has the message
    got = (await _mine(client, ann, dm))["receipts"][str(bob.id)]
    assert got == {"read": 0, "delivered": m["seq"]}


async def test_a_push_the_service_took_counts_as_delivered(client, db, people, sent, monkeypatch):  # noqa: F811
    import app.rooms.router as r
    from app.rooms.push import fan_out

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())
    ann, bob, *_ = people
    await _device(db, bob, "https://push.invalid/bob", CHROME)
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "ring me")
    assert await fan_out(uuid.UUID(m["id"])) == 1
    await _drain()
    assert len(sent) == 1
    assert (await _mine(client, ann, dm))["receipts"][str(bob.id)]["delivered"] == m["seq"]


async def test_no_phone_no_delivered(client, db, people, sent, monkeypatch):  # noqa: F811
    import app.rooms.router as r
    from app.rooms.push import fan_out

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())
    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "ring me")
    await fan_out(uuid.UUID(m["id"]))
    await _drain()
    assert (await _mine(client, ann, dm))["receipts"][str(bob.id)]["delivered"] == 0


async def test_a_group_conversation_has_everyones(client, db, people):  # noqa: F811
    ann, bob, cat, _dan = people
    dm = await _dm(client, ann, bob, cat)
    m = await say(client, ann, dm, "dinner?")
    await client.post(f"/api/rooms/rooms/{dm}/read", headers=H(cat), json={"seq": m["seq"]})
    await _drain()
    got = (await _mine(client, ann, dm))["receipts"]
    assert got[str(cat.id)]["read"] == m["seq"] and got[str(bob.id)]["read"] == 0
    assert str(ann.id) not in got


async def test_space_rooms_show_no_receipts(client, db, people, events):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "hello all")
    r = await client.post(f"/api/rooms/rooms/{room}/delivered", headers=H(bob), json={"seq": m["seq"]})
    assert r.status_code == 204
    await client.post(f"/api/rooms/rooms/{room}/read", headers=H(bob), json={"seq": m["seq"]})
    await _drain()
    assert "receipts" not in await _mine(client, ann, room)
    assert not [e for _u, e in events if e["type"] == "receipt"]


async def test_someone_outside_cant_mark_or_see(client, db, people):  # noqa: F811
    ann, bob, cat, _dan = people
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "private")
    assert (await client.post(f"/api/rooms/rooms/{dm}/delivered", headers=H(cat), json={"seq": m["seq"]})).status_code == 404


async def test_the_server_can_turn_receipts_off(client, db, people, events):  # noqa: F811
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.rooms_read_receipts = False
    await db.commit()
    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "seen?")
    await client.post(f"/api/rooms/rooms/{dm}/read", headers=H(bob), json={"seq": m["seq"]})
    await _drain()
    assert "receipts" not in await _mine(client, ann, dm)
    assert not [e for _u, e in events if e["type"] == "receipt"]


# ------------------------------------------------------------------ muting for a while


def _in(**kw) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kw)).isoformat()


async def _pushed(client, monkeypatch, author, room, words="anyone?", **kw) -> set:
    import app.notifications.dispatch as dispatch
    from app.rooms.push import fan_out

    sent: list[dict] = []

    async def fake_notify(**k):
        sent.append(k)

    monkeypatch.setattr(dispatch, "notify_user", fake_notify)
    m = await say(client, author, room, words, **kw)
    await fan_out(uuid.UUID(m["id"]))
    return {s["user_id"] for s in sent}


async def test_a_room_muted_for_a_while_is_quiet_then_comes_back(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms.models import RoomMember

    ann, bob, cat, _dan = people
    _sid, room = await make_space(client, ann, bob, cat)
    r = await client.patch(f"/api/rooms/rooms/{room}/me", headers=H(bob), json={"muted_until": _in(hours=1)})
    assert r.status_code == 200 and r.json()["muted_until"]
    # Even a mention: quiet means quiet.
    assert await _pushed(client, monkeypatch, ann, room, "@everyone dinner") == {cat.id}

    # The hour passes: Bob's level is what it was.
    st = await db.get(RoomMember, (uuid.UUID(room), bob.id))
    st.muted_until = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    assert await _pushed(client, monkeypatch, ann, room) == {bob.id, cat.id}
    assert (await _mine(client, bob, room))["muted_until"] is None


async def test_choosing_a_level_ends_the_mute_and_a_week_is_the_most(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    r = await client.patch(f"/api/rooms/rooms/{dm}/me", headers=H(bob), json={"muted_until": _in(days=60)})
    until = datetime.fromisoformat(r.json()["muted_until"])
    assert until <= datetime.now(timezone.utc) + timedelta(days=7, minutes=1)
    r = await client.patch(f"/api/rooms/rooms/{dm}/me", headers=H(bob), json={"notify": "all"})
    assert r.json()["muted_until"] is None
    # Asking for a time that's gone is "not muted".
    r = await client.patch(f"/api/rooms/rooms/{dm}/me", headers=H(bob), json={"muted_until": _in(hours=-1)})
    assert r.json()["muted_until"] is None


async def test_a_muted_space_quiets_its_rooms_and_the_badge(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import core

    ann, bob, cat, _dan = people
    sid, room = await make_space(client, ann, bob, cat)
    # Bob has this room on "all" himself: a mute of the whole space still wins.
    await client.patch(f"/api/rooms/rooms/{room}/me", headers=H(bob), json={"notify": "all"})
    r = await client.patch(f"/api/rooms/spaces/{sid}/me", headers=H(bob), json={"muted_until": _in(hours=8)})
    assert r.status_code == 200
    assert await _pushed(client, monkeypatch, ann, room) == {cat.id}
    assert await core.unread_total(db, bob.id) == 0
    assert await core.unread_total(db, cat.id) == 1
    b = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()
    assert b["spaces"][0]["muted_until"]
    # Unmute: the level is still what it was, and the badge counts again.
    await client.patch(f"/api/rooms/spaces/{sid}/me", headers=H(bob), json={"muted_until": None})
    assert await core.unread_total(db, bob.id) == 1


async def test_a_muted_conversation_doesnt_count(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import core

    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    await client.patch(f"/api/rooms/rooms/{dm}/me", headers=H(bob), json={"muted_until": _in(hours=1)})
    assert await _pushed(client, monkeypatch, ann, dm, "psst") == set()
    assert await core.unread_total(db, bob.id) == 0


async def test_new_members_start_on_the_servers_level(client, db, people):  # noqa: F811
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.rooms_default_notify = "mentions"
    await db.commit()
    ann, bob, *_ = people
    await make_space(client, ann, bob)
    for u in (ann, bob):
        b = (await client.get("/api/rooms/bootstrap", headers=H(u))).json()
        assert b["spaces"][0]["notify"] == "mentions"


# ------------------------------------------------------------------ clearing the phone


def test_only_an_app_that_knows_how_is_told():
    from app.notifications import devices

    assert devices.native_version(NATIVE_NEW) == (1, 11, 0)
    assert devices.takes_clears(NATIVE_NEW)
    assert devices.takes_clears("PromptlyAndroid/1.10.1 (Android; Pixel 9)")
    assert not devices.takes_clears(NATIVE_OLD)  # it would show an empty notification
    assert not devices.takes_clears(CHROME)
    assert not devices.takes_clears(None)


async def test_reading_it_anywhere_clears_it_on_the_phone(client, db, people, sent):  # noqa: F811
    ann, bob, *_ = people
    await _device(db, bob, "https://fcm.googleapis.com/fcm/send/new", NATIVE_NEW)
    await _device(db, bob, "https://fcm.googleapis.com/fcm/send/old", NATIVE_OLD)
    await _device(db, bob, "https://push.invalid/laptop", "Mozilla/5.0 (Windows NT 10.0)")
    dm = await _dm(client, ann, bob)
    m1 = await say(client, ann, dm, "one")
    m2 = await say(client, ann, dm, "two")
    await _drain()
    sent.clear()

    # Part-way: the notification still has something unread in it.
    await client.post(f"/api/rooms/rooms/{dm}/read", headers=H(bob), json={"seq": m1["seq"]})
    await _drain()
    assert sent == []

    # To the end, on his laptop.
    await client.post(f"/api/rooms/rooms/{dm}/read", headers=H(bob), json={"seq": m2["seq"]})
    await _drain()
    assert [s["endpoint"] for s in sent] == ["https://fcm.googleapis.com/fcm/send/new"]
    body = json.loads(sent[0]["payload_json"])
    assert body["clear"] is True and body["tag"] == f"room:{dm}" and body["seq"] == m2["seq"]
    assert body["category"] == "room_read" and body["app_badge"] == 0
    assert body["title"] == "" and body["body"] == ""
    assert sent[0]["urgency"] == "low"
    assert sent[0]["topic"] and len(sent[0]["topic"]) <= 32


async def test_replying_clears_it_too_and_never_tells_the_sender(client, db, people, sent):  # noqa: F811
    ann, bob, *_ = people
    await _device(db, bob, "https://fcm.googleapis.com/fcm/send/bob", NATIVE_NEW)
    await _device(db, ann, "https://fcm.googleapis.com/fcm/send/ann", NATIVE_NEW)
    dm = await _dm(client, ann, bob)
    await say(client, ann, dm, "you there?")
    await _drain()
    # Ann's own phone was told her side is read (she wrote it); Bob's got the message.
    clears = [s for s in sent if json.loads(s["payload_json"]).get("clear")]
    assert {s["endpoint"] for s in clears} == {"https://fcm.googleapis.com/fcm/send/ann"}
    sent.clear()

    await say(client, bob, dm, "yes")  # Bob answers from his laptop
    await _drain()
    clears = [s for s in sent if json.loads(s["payload_json"]).get("clear")]
    assert {s["endpoint"] for s in clears} == {"https://fcm.googleapis.com/fcm/send/bob"}


async def test_a_phone_thats_switched_off_isnt_told(client, db, people, sent):  # noqa: F811
    from sqlalchemy import update

    from app.notifications.models import PushSubscription

    ann, bob, *_ = people
    await _device(db, bob, "https://fcm.googleapis.com/fcm/send/bob", NATIVE_NEW)
    await db.execute(update(PushSubscription).where(PushSubscription.user_id == bob.id).values(enabled=False))
    await db.commit()
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "hello")
    await _drain()
    sent.clear()
    await client.post(f"/api/rooms/rooms/{dm}/read", headers=H(bob), json={"seq": m["seq"]})
    await _drain()
    assert sent == []


async def test_a_message_push_says_which_message_it_is(client, db, people, monkeypatch):  # noqa: F811
    import app.notifications.dispatch as dispatch
    from app.rooms.push import fan_out

    got: list[dict] = []

    async def fake_notify(**k):
        got.append(k)

    monkeypatch.setattr(dispatch, "notify_user", fake_notify)
    ann, bob, *_ = people
    dm = await _dm(client, ann, bob)
    m = await say(client, ann, dm, "hi")
    await fan_out(uuid.UUID(m["id"]))
    assert got[-1]["extra"]["seq"] == m["seq"]

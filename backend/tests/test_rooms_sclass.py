"""Rooms S-class pass: "looking at the room" is per device and short-lived,
a retried send isn't posted twice, and a message's notification can be
answered or marked read without opening the app."""
from __future__ import annotations

import time
import uuid

import pytest

from tests.test_rooms import H, _quiet_background, client, make_space, mk_user, people, say  # noqa: F401


@pytest.fixture
def pushes(monkeypatch):
    import app.notifications.dispatch as dispatch

    sent: list[dict] = []

    async def fake_notify(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake_notify)
    return sent


def _user_bodies(got) -> list[dict]:
    msgs = got["messages"] if isinstance(got, dict) else got
    return [m for m in msgs if m["kind"] == "user"]


# ------------------------------------------------------------------ presence


async def test_one_device_leaving_doesnt_speak_for_the_other(client, db, people, pushes):  # noqa: F811
    from app.rooms import core
    from app.rooms.push import fan_out

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    rid = uuid.UUID(room)
    await core.set_presence(bob.id, rid, "desk")
    await core.set_presence(bob.id, rid, "phone")
    await core.set_presence(bob.id, None, "phone")  # the phone locked

    m = await say(client, ann, room, "still there?")
    await fan_out(uuid.UUID(m["id"]))
    assert pushes == []  # the desk is still looking

    await core.set_presence(bob.id, None, "desk")
    m = await say(client, ann, room, "and now?")
    await fan_out(uuid.UUID(m["id"]))
    assert [p["user_id"] for p in pushes] == [bob.id]


async def test_a_device_that_went_quiet_stops_holding_pushes_back(client, db, people, pushes, monkeypatch):  # noqa: F811
    """A phone that locked without saying so, or a tab nobody's using: its
    "looking" lapses in seconds."""
    from app.rooms import core
    from app.rooms.push import fan_out

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await core.set_presence(bob.id, uuid.UUID(room), "phone")
    assert await core.viewing([bob.id]) == {str(bob.id): {room}}

    later = time.time() + core.PRESENCE_S + 1
    monkeypatch.setattr(core.time, "time", lambda: later)
    assert await core.viewing([bob.id]) == {}
    m = await say(client, ann, room, "you there?")
    await fan_out(uuid.UUID(m["id"]))
    assert [p["user_id"] for p in pushes] == [bob.id]
    monkeypatch.undo()
    await core.set_presence(bob.id, None, "phone")


async def test_the_presence_endpoint_takes_a_device(client, db, people):  # noqa: F811
    from app.rooms import core

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    r = await client.post("/api/rooms/presence", headers=H(bob), json={"room_id": room, "device": "tab-1"})
    assert r.status_code == 204
    assert await core.viewing([bob.id]) == {str(bob.id): {room}}
    r = await client.post("/api/rooms/presence", headers=H(bob), json={"room_id": None, "device": "tab-1"})
    assert r.status_code == 204
    assert await core.viewing([bob.id]) == {}
    # An older page names no device: still works.
    r = await client.post("/api/rooms/presence", headers=H(bob), json={"room_id": room})
    assert r.status_code == 204 and await core.viewing([bob.id]) == {str(bob.id): {room}}
    await core.set_presence(bob.id, None)


# ------------------------------------------------------------------ sending twice


async def test_a_retried_send_is_not_posted_twice(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    first = await say(client, ann, room, "on my way", client_id="c-123")
    again = await say(client, ann, room, "on my way", client_id="c-123")
    assert again["id"] == first["id"] and again["seq"] == first["seq"]
    other = await say(client, ann, room, "on my way", client_id="c-456")
    assert other["id"] != first["id"]
    # Someone else's same id is their own message.
    theirs = await say(client, bob, room, "ok", client_id="c-123")
    assert theirs["id"] != first["id"]
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()
    assert [m["body"] for m in _user_bodies(got)].count("on my way") == 2


# ------------------------------------------------------------------ from the notification


async def _buttons(client, pushes, ann, bob):
    from app.rooms.push import fan_out

    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    m = await say(client, ann, dm["id"], "dinner at 6?")
    await fan_out(uuid.UUID(m["id"]))
    reply, read = pushes[-1]["extra"]["actions"]
    return dm["id"], reply, read


async def test_a_message_push_carries_reply_and_mark_as_read(client, db, people, pushes):  # noqa: F811
    ann, bob, *_ = people
    _room, reply, read = await _buttons(client, pushes, ann, bob)
    assert (reply["action"], reply["type"], reply["title"]) == ("room_reply", "text", "Reply")
    assert (read["action"], read["title"]) == ("room_read", "Mark as read") and "type" not in read


async def test_mark_as_read_from_the_notification(client, db, people, pushes):  # noqa: F811
    from app.rooms.core import unread_total

    ann, bob, *_ = people
    bob_id = bob.id
    _room, _reply, read = await _buttons(client, pushes, ann, bob)
    assert await unread_total(db, bob_id) == 1
    r = await client.post("/api/notifications/action", json={"token": read["token"]})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert await unread_total(db, bob_id) == 0


async def test_reply_from_the_notification_sends_as_you(client, db, people, pushes):  # noqa: F811
    from app.rooms.core import unread_total

    ann, bob, *_ = people
    bob_id = bob.id
    room, reply, _read = await _buttons(client, pushes, ann, bob)
    r = await client.post("/api/notifications/action", json={"token": reply["token"], "text": "  yes, see you then  "})
    assert r.status_code == 200, r.text
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()
    last = _user_bodies(got)[-1]
    assert last["body"] == "yes, see you then" and last["author_id"] == str(bob_id)
    db.expire_all()
    assert await unread_total(db, bob_id) == 0  # replying reads it


async def test_a_reply_with_no_words_does_nothing(client, db, people, pushes):  # noqa: F811
    ann, bob, *_ = people
    room, reply, read = await _buttons(client, pushes, ann, bob)
    assert (await client.post("/api/notifications/action", json={"token": reply["token"]})).status_code == 410
    assert (await client.post("/api/notifications/action", json={"token": reply["token"], "text": "   "})).status_code == 410
    # A mark-as-read token can't be used to send words.
    r = await client.post("/api/notifications/action", json={"token": read["token"], "text": "sneaky"})
    assert r.status_code == 200
    got = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()
    assert [m["body"] for m in _user_bodies(got)] == ["dinner at 6?"]


async def test_the_buttons_stop_working_once_youve_left(client, db, people, pushes):  # noqa: F811
    from app.rooms.push import fan_out

    ann, bob, cat, _dan = people
    sid, room = await make_space(client, ann, bob, cat)
    m = await say(client, ann, room, "hello all")
    await fan_out(uuid.UUID(m["id"]))
    push = next(p for p in pushes if p["user_id"] == bob.id)
    reply = push["extra"]["actions"][0]["token"]
    r = await client.delete(f"/api/rooms/spaces/{sid}/members/{bob.id}", headers=H(ann))
    assert r.status_code == 204, r.text
    r = await client.post("/api/notifications/action", json={"token": reply, "text": "still here"})
    assert r.status_code == 410


# ------------------------------------------------------------------ remind me


def test_remind_me_times_are_never_in_the_past():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.rooms.service import remind_time

    tz = ZoneInfo("Australia/Brisbane")
    lunch = datetime(2026, 11, 13, 12, 30, tzinfo=tz)
    late = datetime(2026, 11, 13, 21, 15, tzinfo=tz)
    assert remind_time(lunch, "hour") == ("2026-11-13", "13:30")
    assert remind_time(lunch, "evening") == ("2026-11-13", "18:00")
    assert remind_time(late, "evening") == ("2026-11-14", "18:00")
    assert remind_time(late, "hour") == ("2026-11-13", "22:15")
    assert remind_time(datetime(2026, 11, 13, 23, 40, tzinfo=tz), "hour") == ("2026-11-14", "00:40")
    assert remind_time(late, "tomorrow") == ("2026-11-14", "09:00")
    assert remind_time(late, "none") == (None, None)


async def test_remind_me_makes_your_own_task_that_links_back(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "can you **book** the vet for Tuesday?")
    r = await client.post(f"/api/rooms/messages/{m['id']}/remind", headers=H(bob), json={"when": "tomorrow"})
    assert r.status_code == 201, r.text
    got = r.json()
    assert got["title"].endswith("can you book the vet for Tuesday?") and got["time"] == "09:00" and got["due"]
    # It's in bob's Tasks, not ann's, and points at the message.
    from sqlalchemy import select

    from app.items.models import ItemDocument as ItemDoc

    docs = (await db.execute(select(ItemDoc).where(ItemDoc.kind == "tasks"))).scalars().all()
    tasks = [t for d in docs for t in d.data.get("tasks", [])]
    assert len(tasks) == 1
    assert f"/rooms/r/{room}?m={m['seq']}" in tasks[0]["notes"] and tasks[0]["alerts"] == [0]


async def test_you_cant_set_a_reminder_on_a_message_you_cant_see(client, db, people):  # noqa: F811
    ann, bob, cat, _dan = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "private plans")
    r = await client.post(f"/api/rooms/messages/{m['id']}/remind", headers=H(cat), json={"when": "hour"})
    assert r.status_code in (403, 404)

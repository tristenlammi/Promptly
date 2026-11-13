"""A Rooms DM actually reaches the other person's phone: the push leaves the
server (not just "no inbox row"). Owner report 2026-11-13: DMs in either
direction notified nobody, while the test push arrived."""
from __future__ import annotations

import asyncio
import uuid

import pytest

from tests.test_rooms import H, client, mk_user, say  # noqa: F401


@pytest.fixture(autouse=True)
def _one_send_per_message(monkeypatch):
    """The endpoint spawns the fan-out too; these tests run it themselves."""
    import app.rooms.router as r

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


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


async def _drain():
    from app import background

    for _ in range(100):
        if background.pending_count() == 0:
            return
        await asyncio.sleep(0.05)


async def _phone(db, user, endpoint):
    from app.notifications.models import PushSubscription

    db.add(PushSubscription(user_id=user.id, endpoint=endpoint, p256dh="k", auth="a",
                            user_agent="Mozilla/5.0 (Linux; Android 16; Pixel 9) Mobile", enabled=True))
    await db.commit()


async def test_a_dm_pushes_to_the_other_persons_phone(client, db, sent):  # noqa: F811
    from app.rooms.push import fan_out

    ann = await mk_user(db, "ann")
    bob = await mk_user(db, "bob")
    await _phone(db, bob, "https://push.invalid/bob-phone")
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    m = await say(client, ann, dm["id"], "are you home?")

    got = await fan_out(uuid.UUID(m["id"]))
    await _drain()

    assert got == 1
    assert [s["endpoint"] for s in sent] == ["https://push.invalid/bob-phone"]
    # Kept for a phone asleep in a pocket (pywebpush's own default is 0 s:
    # "now or never"), and it wakes the phone.
    assert sent[0]["ttl"] == 24 * 3600
    assert sent[0]["urgency"] == "high"


async def test_the_reply_pushes_back(client, db, sent):  # noqa: F811
    from app.rooms.push import fan_out

    ann = await mk_user(db, "ann")
    bob = await mk_user(db, "bob")
    await _phone(db, ann, "https://push.invalid/ann-phone")
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    m = await say(client, bob, dm["id"], "yes, home now")

    await fan_out(uuid.UUID(m["id"]))
    await _drain()

    assert [s["endpoint"] for s in sent] == ["https://push.invalid/ann-phone"]


def test_only_messages_calls_and_reminders_wake_a_dozing_phone():
    from app.notifications.dispatch import default_urgency

    assert default_urgency("room_message") == "high"
    assert default_urgency("item_reminder") == "high"
    assert default_urgency("calendar") == "high"
    assert default_urgency("porch") == "normal"
    assert default_urgency("mail") == "normal"

"""The Android app's camera for Rooms (``app/rooms/camera.py``): a ticket
that sends photos and videos to one conversation as one person, and can do
nothing else."""
from __future__ import annotations

import time
import uuid

import jwt
import pytest

from tests.test_rooms import H, make_space, mk_user, say
from tests.test_rooms_uploads import client, root  # noqa: F401 - fixtures

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8cfc0f01f0005050201a5f645400000000049454e44ae426082"
)


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


async def ticket(client, u, room, **body) -> dict:
    r = await client.post(f"/api/rooms/rooms/{room}/camera-ticket", headers=H(u), json=body or None)
    assert r.status_code == 201, r.text
    return r.json()


async def shoot(client, t: str | None, *, name="photo.jpg", data=PNG, mime="image/png", body="", client_id=None):
    headers = {"X-Promptly-Camera-Ticket": t} if t is not None else {}
    return await client.post(
        "/api/rooms/camera/send",
        headers=headers,
        files={"file": (name, data, mime)},
        data={"body": body, "client_id": client_id or uuid.uuid4().hex},
    )


async def messages(client, u, room) -> list[dict]:
    r = await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["messages"]


async def test_a_photo_with_its_words_arrives_as_one_message(client, db, people):
    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    t = await ticket(client, ann, room)
    assert t["max_bytes"] == 50 * 1024 * 1024 and t["expires_at"] > time.time()

    r = await shoot(client, t["ticket"], body="  The view  ")
    assert r.status_code == 201, r.text
    sent = r.json()
    assert sent["body"] == "The view"
    assert [a["filename"] for a in sent["attachments"]] == ["photo.jpg"]

    seen = [m for m in await messages(client, bob, room) if m["id"] == sent["id"]]
    assert seen and seen[0]["author_id"] == str(ann.id)
    # Nothing is left waiting to be sent.
    from sqlalchemy import text

    assert (await db.execute(text("SELECT count(*) FROM room_attachments WHERE message_id IS NULL"))).scalar() == 0


async def test_the_same_send_twice_is_one_message(client, db, people):
    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    t = (await ticket(client, ann, room))["ticket"]
    cid = uuid.uuid4().hex
    a = await shoot(client, t, client_id=cid, body="once")
    b = await shoot(client, t, client_id=cid, body="once")
    assert a.status_code == 201 and b.status_code == 201
    assert a.json()["id"] == b.json()["id"]
    assert sum(1 for m in await messages(client, ann, room) if m["body"] == "once") == 1


async def test_a_reply_goes_to_the_message_it_was_opened_on(client, db, people):
    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    first = await say(client, bob, room, "Show me")
    t = (await ticket(client, ann, room, reply_to_id=first["id"]))["ticket"]
    r = await shoot(client, t)
    assert r.status_code == 201, r.text
    assert r.json()["reply_to"]["id"] == first["id"]


async def test_no_ticket_a_forged_one_or_another_kind_of_token_is_refused(client, db, people):
    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    from app.auth.utils import create_access_token
    from app.config import get_settings

    assert (await shoot(client, None)).status_code == 401
    assert (await shoot(client, "nonsense")).status_code == 401
    # A sign-in token isn't a camera ticket.
    assert (await shoot(client, create_access_token(ann.id, token_version=ann.token_version))).status_code == 401
    now = int(time.time())
    claims = {"typ": "rooms-camera", "sub": str(ann.id), "room": str(room), "jti": "x", "iat": now, "exp": now + 60}
    assert (await shoot(client, jwt.encode(claims, "not the server's key", algorithm="HS256"))).status_code == 401
    old = jwt.encode({**claims, "exp": now - 5}, get_settings().SECRET_KEY, algorithm="HS256")
    assert (await shoot(client, old)).status_code == 401
    assert await messages(client, ann, room) == [] or all(not m["attachments"] for m in await messages(client, ann, room))


async def test_a_ticket_is_for_its_own_conversation_and_only_while_you_are_in_it(client, db, people):
    ann, bob, cat = people
    sid, room = await make_space(client, ann, bob)
    # Someone outside can't ask for one.
    r = await client.post(f"/api/rooms/rooms/{room}/camera-ticket", headers=H(cat))
    assert r.status_code == 404
    t = (await ticket(client, bob, room))["ticket"]
    assert (await shoot(client, t)).status_code == 201
    # Removed from the space: the ticket in the phone's hand stops working.
    r = await client.delete(f"/api/rooms/spaces/{sid}/members/{bob.id}", headers=H(ann))
    assert r.status_code in (200, 204), r.text
    assert (await shoot(client, t)).status_code == 404


async def test_only_photos_and_videos_and_never_anything_to_read(client, db, people):
    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    await say(client, bob, room, "A private word")
    t = (await ticket(client, ann, room))["ticket"]
    assert (await shoot(client, t, name="notes.txt", data=b"words", mime="text/plain")).status_code == 415
    assert (await shoot(client, t, name="x.svg", data=b"<svg/>", mime="image/svg+xml")).status_code == 415
    # The ticket opens nothing else: it isn't a sign-in.
    for path in (f"/api/rooms/rooms/{room}/messages", "/api/rooms/bootstrap", "/api/rooms/uploads"):
        r = await client.get(path, headers={"X-Promptly-Camera-Ticket": t, "Authorization": f"Bearer {t}"})
        assert r.status_code in (401, 403), (path, r.status_code)


async def test_a_ticket_has_a_limit_and_a_failed_send_does_not_use_it_up(client, db, people, monkeypatch):
    from app.rooms import camera

    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    monkeypatch.setattr(camera, "MAX_SENDS", 2)
    t = (await ticket(client, ann, room))["ticket"]
    assert (await shoot(client, t, data=b"")).status_code == 400  # empty: didn't count
    assert (await shoot(client, t)).status_code == 201
    assert (await shoot(client, t)).status_code == 201
    assert (await shoot(client, t)).status_code == 429


async def test_what_the_camera_sends_is_a_rooms_upload_not_a_drive_file(client, db, people):
    """Rooms is never read by AI: every AI path starts from ``files``."""
    from sqlalchemy import text

    ann, bob, _ = people
    _, room = await make_space(client, ann, bob)
    before = (await db.execute(text("SELECT count(*) FROM files"))).scalar()
    t = (await ticket(client, ann, room))["ticket"]
    assert (await shoot(client, t)).status_code == 201
    assert (await db.execute(text("SELECT count(*) FROM files"))).scalar() == before
    assert (await db.execute(text("SELECT count(*) FROM room_attachments WHERE message_id IS NOT NULL"))).scalar() == 1

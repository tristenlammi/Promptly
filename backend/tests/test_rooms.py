"""Rooms: spaces, rooms, DMs, messages, reactions, read state, pins,
attachments, search, push rules and @promptly's privacy rules."""
from __future__ import annotations

import io
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
    """Endpoints spawn push fan-out and @promptly; tests call those directly."""
    import app.rooms.router as r

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}", password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat", "dan")]


async def make_space(client, owner, *members, name="Family"):
    r = await client.post("/api/rooms/spaces", headers=H(owner), json={"name": name, "emoji": "🏡"})
    assert r.status_code == 201, r.text
    sid, rid = r.json()["id"], r.json()["room_id"]
    if members:
        r = await client.post(f"/api/rooms/spaces/{sid}/members", headers=H(owner), json={"user_ids": [str(m.id) for m in members]})
        assert r.status_code == 200, r.text
    return sid, rid


async def say(client, u, room_id, body, **kw):
    r = await client.post(f"/api/rooms/rooms/{room_id}/messages", headers=H(u), json={"body": body, **kw})
    assert r.status_code == 201, r.text
    return r.json()


# ------------------------------------------------------------------ spaces & access


async def test_space_lifecycle_and_access(client, people):
    ann, bob, cat, _ = people
    sid, general = await make_space(client, ann, bob)
    boot = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()
    assert [s["name"] for s in boot["spaces"]] == ["Family"]
    assert boot["spaces"][0]["role"] == "member" and boot["spaces"][0]["rooms"][0]["name"] == "general"
    assert str(ann.id) in boot["users"] and boot["users"][str(ann.id)]["username"] == ann.username
    assert boot["spaces"][0]["member_roles"] == {str(ann.id): "owner", str(bob.id): "member"}
    # Outsiders see nothing — and get 404s, not 403s.
    assert (await client.get("/api/rooms/bootstrap", headers=H(cat))).json()["spaces"] == []
    assert (await client.get(f"/api/rooms/rooms/{general}/messages", headers=H(cat))).status_code == 404
    assert (await client.post(f"/api/rooms/rooms/{general}/messages", headers=H(cat), json={"body": "hi"})).status_code == 404
    # Members can't manage; admins can.
    assert (await client.post(f"/api/rooms/spaces/{sid}/rooms", headers=H(bob), json={"name": "x"})).status_code == 403
    r = await client.post(f"/api/rooms/spaces/{sid}/rooms", headers=H(ann), json={"name": "Trip Planning", "topic": "Bali"})
    assert r.status_code == 201 and r.json()["name"] == "trip-planning"
    assert (await client.patch(f"/api/rooms/spaces/{sid}/members/{bob.id}", headers=H(ann), json={"role": "admin"})).status_code == 200
    assert (await client.post(f"/api/rooms/spaces/{sid}/rooms", headers=H(bob), json={"name": "photos"})).status_code == 201
    # The owner can't leave; others can; admins can't remove the owner.
    assert (await client.delete(f"/api/rooms/spaces/{sid}/members/{ann.id}", headers=H(ann))).status_code == 403
    assert (await client.delete(f"/api/rooms/spaces/{sid}/members/{ann.id}", headers=H(bob))).status_code == 403
    # Handing over ownership.
    assert (await client.patch(f"/api/rooms/spaces/{sid}/members/{bob.id}", headers=H(bob), json={"role": "owner"})).status_code == 403
    assert (await client.patch(f"/api/rooms/spaces/{sid}/members/{bob.id}", headers=H(ann), json={"role": "owner"})).status_code == 200
    roles = {s["role"] for s in (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()["spaces"]}
    assert roles == {"admin"}
    assert (await client.delete(f"/api/rooms/spaces/{sid}/members/{ann.id}", headers=H(ann))).status_code == 204
    assert (await client.get(f"/api/rooms/rooms/{general}/messages", headers=H(ann))).status_code == 404
    assert (await client.delete(f"/api/rooms/spaces/{sid}", headers=H(bob))).status_code == 204
    assert (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()["spaces"] == []


# ------------------------------------------------------------------ messages


async def test_messages_seq_pagination_edit_delete(client, people):
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    for i in range(1, 8):
        m = await say(client, ann if i % 2 else bob, room, f"message {i}", client_id=f"c{i}")
        assert m["seq"] == i and m["meta"]["client_id"] == f"c{i}"
    page = (await client.get(f"/api/rooms/rooms/{room}/messages?limit=3", headers=H(bob))).json()
    assert [m["seq"] for m in page["messages"]] == [5, 6, 7] and page["has_more_before"] and not page["has_more_after"]
    page = (await client.get(f"/api/rooms/rooms/{room}/messages?before=5&limit=3", headers=H(bob))).json()
    assert [m["seq"] for m in page["messages"]] == [2, 3, 4] and page["has_more_before"]
    page = (await client.get(f"/api/rooms/rooms/{room}/messages?after=5", headers=H(bob))).json()
    assert [m["seq"] for m in page["messages"]] == [6, 7]
    page = (await client.get(f"/api/rooms/rooms/{room}/messages?around=4&limit=4", headers=H(bob))).json()
    assert [m["seq"] for m in page["messages"]] == [2, 3, 4, 5] and page["has_more_after"]

    first = page["messages"][0]
    reply = await say(client, bob, room, "replying", reply_to_id=first["id"])
    assert reply["reply_to"]["seq"] == 2 and reply["reply_to"]["body"] == "message 2"
    # Only the author edits; edits are marked.
    assert (await client.patch(f"/api/rooms/messages/{reply['id']}", headers=H(ann), json={"body": "x"})).status_code == 403
    r = await client.patch(f"/api/rooms/messages/{reply['id']}", headers=H(bob), json={"body": "replying (edited)"})
    assert r.status_code == 200 and r.json()["edited_at"] and r.json()["body"] == "replying (edited)"
    # Anyone pins; deleting clears the body and the pin.
    r = await client.patch(f"/api/rooms/messages/{reply['id']}", headers=H(ann), json={"pinned": True})
    assert r.json()["pinned"] is True
    assert [m["id"] for m in (await client.get(f"/api/rooms/rooms/{room}/pins", headers=H(ann))).json()] == [reply["id"]]
    assert (await client.delete(f"/api/rooms/messages/{reply['id']}", headers=H(bob))).status_code == 204
    gone = (await client.get(f"/api/rooms/rooms/{room}/messages?around=8&limit=2", headers=H(ann))).json()["messages"]
    deleted = next(m for m in gone if m["id"] == reply["id"])
    assert deleted["deleted"] and deleted["body"] == "" and not deleted["pinned"]
    assert (await client.get(f"/api/rooms/rooms/{room}/pins", headers=H(ann))).json() == []
    # Empty / oversized messages are refused.
    assert (await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"body": "  "})).status_code == 400
    assert (await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"body": "x" * 9000})).status_code == 422


async def test_admin_can_delete_others_messages(client, people):
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, bob, room, "oops")
    assert (await client.delete(f"/api/rooms/messages/{m['id']}", headers=H(ann))).status_code == 204


async def test_reactions(client, people):
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "dinner at 6?")
    r = await client.put(f"/api/rooms/messages/{m['id']}/reactions", headers=H(bob), json={"emoji": "👍"})
    assert r.json()["reactions"] == [{"emoji": "👍", "user_ids": [str(bob.id)]}]
    await client.put(f"/api/rooms/messages/{m['id']}/reactions", headers=H(ann), json={"emoji": "👍"})
    await client.put(f"/api/rooms/messages/{m['id']}/reactions", headers=H(ann), json={"emoji": "👍"})  # idempotent
    r = await client.delete(f"/api/rooms/messages/{m['id']}/reactions", headers=H(bob), params={"emoji": "👍"})
    assert r.json()["reactions"] == [{"emoji": "👍", "user_ids": [str(ann.id)]}]


async def test_read_state_unread_and_mentions(client, people):
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await say(client, ann, room, "hello all")
    await say(client, ann, room, f"@{bob.username} can you grab milk?")
    await say(client, ann, room, "@everyone dinner's ready")
    rb = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()["spaces"][0]["rooms"][0]
    assert (rb["unread"], rb["mentions"]) == (3, 2)
    ra = (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()["spaces"][0]["rooms"][0]
    assert (ra["unread"], ra["mentions"]) == (0, 0)  # your own messages are read
    r = await client.post(f"/api/rooms/rooms/{room}/read", headers=H(bob), json={"seq": 2})
    assert r.json()["last_read_seq"] == 2
    rb = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()["spaces"][0]["rooms"][0]
    assert (rb["unread"], rb["mentions"]) == (1, 1)
    # Reading never goes backwards or past the end.
    assert (await client.post(f"/api/rooms/rooms/{room}/read", headers=H(bob), json={"seq": 1})).json()["last_read_seq"] == 2
    assert (await client.post(f"/api/rooms/rooms/{room}/read", headers=H(bob), json={"seq": 99})).json()["last_read_seq"] == 3


# ------------------------------------------------------------------ DMs


async def test_dms(client, people):
    ann, bob, cat, _ = people
    r = await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})
    dm = r.json()
    assert dm["kind"] == "dm" and set(dm["members"]) == {str(ann.id), str(bob.id)}
    # The same 1:1 every time, from either side.
    assert (await client.post("/api/rooms/dms", headers=H(bob), json={"user_ids": [str(ann.id)]})).json()["id"] == dm["id"]
    # Bob doesn't see an empty conversation Ann opened… until she writes.
    assert (await client.get("/api/rooms/bootstrap", headers=H(cat))).json()["dms"] == []
    await say(client, ann, dm["id"], "hey")
    bdms = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()["dms"]
    assert [d["id"] for d in bdms] == [dm["id"]] and bdms[0]["preview"]["body"] == "hey" and bdms[0]["unread"] == 1
    # Private: a third person can't read it.
    assert (await client.get(f"/api/rooms/rooms/{dm['id']}/messages", headers=H(cat))).status_code == 404
    # Closing hides it; a new message brings it back.
    await client.patch(f"/api/rooms/rooms/{dm['id']}/me", headers=H(bob), json={"hidden": True})
    assert (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()["dms"] == []
    await say(client, ann, dm["id"], "you there?")
    assert len((await client.get("/api/rooms/bootstrap", headers=H(bob))).json()["dms"]) == 1
    # Group conversations; DMs have no admin switches.
    g = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id), str(cat.id)]})).json()
    assert g["kind"] == "group" and len(g["members"]) == 3
    assert (await client.patch(f"/api/rooms/rooms/{g['id']}", headers=H(cat), json={"name": "Weekend crew"})).json()["name"] == "Weekend crew"
    assert (await client.patch(f"/api/rooms/rooms/{dm['id']}", headers=H(ann), json={"ai_context": True})).status_code == 403
    assert (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(ann.id)]})).status_code == 400


async def test_dm_ai_needs_everyone(client, people):
    ann, bob, *_ = people
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    r = await client.patch(f"/api/rooms/rooms/{dm['id']}/me", headers=H(ann), json={"ai_ok": True})
    assert r.json()["ai_context"] is False and r.json()["ai_ok"][str(ann.id)] is True
    r = await client.patch(f"/api/rooms/rooms/{dm['id']}/me", headers=H(bob), json={"ai_ok": True})
    assert r.json()["ai_context"] is True
    msgs = (await client.get(f"/api/rooms/rooms/{dm['id']}/messages", headers=H(ann))).json()["messages"]
    assert [m["kind"] for m in msgs] == ["system", "system"]


# ------------------------------------------------------------------ attachments


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (1200, 800), "#336699").save(buf, format="PNG")
    return buf.getvalue()


async def test_attachments(client, people):
    ann, bob, cat, _ = people
    _sid, room = await make_space(client, ann, bob)
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(ann), files={"file": ("beach.png", _png(), "image/png")})
    assert r.status_code == 201, r.text
    att = r.json()
    assert (att["width"], att["height"]) == (1200, 800) and att["thumb_url"]
    # Someone else can't send your upload; outsiders can't upload.
    assert (await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(bob), json={"attachment_ids": [att["id"]]})).status_code == 400
    assert (await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(cat), files={"file": ("x.txt", b"x", "text/plain")})).status_code == 404
    m = await say(client, ann, room, "", attachment_ids=[att["id"]])
    assert m["attachments"][0]["id"] == att["id"]
    # Can't be attached twice.
    assert (await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"attachment_ids": [att["id"]]})).status_code == 400
    # The signed URL serves it without a bearer; a bad signature is a 404.
    r = await client.get(att["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.headers["x-content-type-options"] == "nosniff"
    t = await client.get(att["thumb_url"])
    assert t.status_code == 200 and t.headers["content-type"] == "image/webp"
    assert (await client.get(att["url"].replace("sig=", "sig=0"))).status_code == 404
    # Risky types download rather than render.
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(ann), files={"file": ("page.html", b"<script>alert(1)</script>", "text/html")})
    h = await client.get(r.json()["url"])
    assert h.headers["content-type"] == "application/octet-stream" and h.headers["content-disposition"].startswith("attachment")
    # Deleting the message removes the file.
    await client.delete(f"/api/rooms/messages/{m['id']}", headers=H(ann))
    assert (await client.get(att["url"])).status_code == 404


async def test_attachments_never_reach_files(client, db, people):
    from app.files.models import UserFile

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(ann), files={"file": ("doc.txt", b"secret plans", "text/plain")})
    assert (await db.execute(select(UserFile))).scalars().all() == []


# ------------------------------------------------------------------ search


async def test_search_scope(client, people):
    ann, bob, cat, _ = people
    _sid, room = await make_space(client, ann, bob)
    _sid2, other = await make_space(client, cat, name="Work")
    await say(client, ann, room, "The Bunnings trip is on Saturday")
    await say(client, cat, other, "Saturday standup moved")
    hits = (await client.get("/api/rooms/search", headers=H(bob), params={"q": "saturday"})).json()
    assert [h["message"]["body"] for h in hits] == ["The Bunnings trip is on Saturday"]
    assert (await client.get("/api/rooms/search", headers=H(bob), params={"q": "saturday", "room_id": other})).status_code == 404
    assert (await client.get("/api/rooms/search", headers=H(bob), params={"q": "bunnings saturday"})).json()[0]["room_id"] == room


async def test_people_picker(client, people):
    ann, bob, cat, _ = people
    await make_space(client, ann, bob)
    names = {p["username"] for p in (await client.get("/api/rooms/people", headers=H(ann))).json()}
    assert names == {bob.username}  # no roster dump without a search
    found = {p["username"] for p in (await client.get("/api/rooms/people", headers=H(ann), params={"q": cat.username[:3]})).json()}
    assert cat.username in found


# ------------------------------------------------------------------ push


async def test_push_rules(client, db, people, monkeypatch):
    import app.notifications.dispatch as dispatch
    from app.rooms import core
    from app.rooms.models import RoomMessage
    from app.rooms.push import fan_out

    ann, bob, cat, dan = people
    sid, room = await make_space(client, ann, bob, cat, dan)
    sent: list[dict] = []

    async def fake_notify(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake_notify)
    await client.patch(f"/api/rooms/spaces/{sid}/me", headers=H(cat), json={"notify": "mentions"})
    await client.patch(f"/api/rooms/rooms/{room}/me", headers=H(dan), json={"notify": "none"})
    await core.set_presence(bob.id, uuid.UUID(room))  # bob is looking at it
    m = await say(client, ann, room, "Who's in for Saturday?")
    await fan_out(uuid.UUID(m["id"]))
    assert sent == []  # bob's looking, cat wants mentions, dan muted it
    await core.set_presence(bob.id, None)
    m = await say(client, ann, room, f"@{cat.username} you in?")
    await fan_out(uuid.UUID(m["id"]))
    who = {s["user_id"] for s in sent}
    assert who == {bob.id, cat.id}
    push = next(s for s in sent if s["user_id"] == cat.id)
    assert push["category"] == "room_message" and push["inbox"] is False
    assert push["title"] == "Family · #general" and push["body"].startswith(f"{ann.username}: @{cat.username}")
    assert push["url"] == f"/rooms/r/{room}" and push["tag"] == f"room:{room}"
    # Stacked in the tray with the sender's picture; the badge is cat's unread total.
    extra = push["extra"]
    assert extra["stack"] is True and extra["line"] == push["body"] and extra["icon"] == "/item-icons/rooms-192.png"
    assert extra["app_badge"] == 2
    sent.clear()
    reply = await say(client, bob, room, "sure", reply_to_id=m["id"])
    await fan_out(uuid.UUID(reply["id"]))
    assert {s["user_id"] for s in sent} == {ann.id}  # cat: not a mention of her
    msg = await db.get(RoomMessage, uuid.UUID(reply["id"]))
    assert msg is not None


async def test_unread_total_skips_muted(client, db, people):
    from app.rooms.core import unread_total

    ann, bob, *_ = people
    sid, room = await make_space(client, ann, bob)
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    await say(client, ann, room, "one")
    await say(client, ann, room, "two")
    await say(client, ann, dm["id"], "psst")
    assert await unread_total(db, bob.id) == 3 and await unread_total(db, ann.id) == 0
    await client.patch(f"/api/rooms/spaces/{sid}/me", headers=H(bob), json={"notify": "none"})
    bob_id = bob.id
    db.expire_all()
    assert await unread_total(db, bob_id) == 1


async def test_dm_push_and_no_inbox(client, db, people, monkeypatch):
    from app.notifications.models import Notification
    from app.rooms.push import fan_out

    ann, bob, *_ = people
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    m = await say(client, ann, dm["id"], "**hey** you")
    await fan_out(uuid.UUID(m["id"]))
    assert (await db.execute(select(Notification))).scalars().all() == []


# ------------------------------------------------------------------ @promptly


@pytest.fixture
def fake_model(monkeypatch):
    import app.files.editor_ai as editor_ai
    import app.rooms.promptly as promptly

    calls: list[dict] = []

    async def model_for(db, user):
        return object(), "test-model"

    async def complete(provider, model_id, *, system, messages, **kw):
        calls.append({"system": system, "messages": messages})
        return "Bunnings closes at 9pm."

    monkeypatch.setattr(promptly, "model_for", model_for)
    monkeypatch.setattr(editor_ai, "complete", complete)
    return calls


async def test_promptly_sees_only_the_ask_by_default(client, people, fake_model):
    from app.rooms.promptly import answer

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await say(client, bob, room, "my secret: the surprise party is Friday")
    q = await say(client, ann, room, "@promptly when does Bunnings close?")
    assert "promptly" in q["mentions"]
    reply_id = await answer(uuid.UUID(q["id"]))
    seen = fake_model[0]["messages"][0]["content"]
    assert "Bunnings" in seen and "surprise party" not in seen
    assert "can only see the message that mentions you" in fake_model[0]["system"]
    msgs = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()["messages"]
    last = msgs[-1]
    assert last["id"] == str(reply_id) and last["kind"] == "promptly" and last["body"] == "Bunnings closes at 9pm."
    assert last["reply_to"]["id"] == q["id"] and last["meta"]["asked_by"] == str(ann.id) and last["author_id"] is None
    # The asker may delete Promptly's answer to them; others may not.
    assert (await client.delete(f"/api/rooms/messages/{reply_id}", headers=H(bob))).status_code == 403
    assert (await client.delete(f"/api/rooms/messages/{reply_id}", headers=H(ann))).status_code == 204


async def test_promptly_reply_includes_quoted_message(client, people, fake_model):
    from app.rooms.promptly import answer

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await say(client, bob, room, "unrelated chatter")
    parent = await say(client, bob, room, "The recipe says 250g flour, 3 eggs")
    q = await say(client, ann, room, "@promptly double this", reply_to_id=parent["id"])
    await answer(uuid.UUID(q["id"]))
    seen = fake_model[0]["messages"][0]["content"]
    assert "250g flour" in seen and "unrelated" not in seen


async def test_promptly_reads_history_in_ai_rooms_only(client, people, fake_model):
    from app.rooms.promptly import answer

    ann, bob, *_ = people
    sid, room = await make_space(client, ann, bob)
    # Only admins flip the switch; it's announced in the room.
    assert (await client.patch(f"/api/rooms/rooms/{room}", headers=H(bob), json={"ai_context": True})).status_code == 403
    r = await client.patch(f"/api/rooms/rooms/{room}", headers=H(ann), json={"ai_context": True})
    assert r.json()["ai_context"] is True
    await say(client, bob, room, "Let's do the beach on Sunday")
    q = await say(client, ann, room, "@promptly what did we decide?")
    await answer(uuid.UUID(q["id"]))
    seen = fake_model[0]["messages"][0]["content"]
    assert "beach on Sunday" in seen and "can see this conversation's recent messages" in fake_model[0]["system"]
    # …and never another room's.
    other = (await client.post(f"/api/rooms/spaces/{sid}/rooms", headers=H(ann), json={"name": "private"})).json()["id"]
    await say(client, bob, other, "gift idea: kayak")
    q2 = await say(client, ann, room, "@promptly anything about gifts?")
    await answer(uuid.UUID(q2["id"]))
    assert "kayak" not in fake_model[1]["messages"][0]["content"]


async def test_promptly_without_a_model(client, people, monkeypatch):
    import app.rooms.promptly as promptly

    async def no_model(db, user):
        raise LookupError("no model")

    monkeypatch.setattr(promptly, "model_for", no_model)
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    q = await say(client, ann, room, "@promptly hi")
    await promptly.answer(uuid.UUID(q["id"]))
    last = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()["messages"][-1]
    assert last["kind"] == "promptly" and "no AI model is set up" in last["body"]


async def test_rooms_stay_out_of_drive_search(client, people):
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    await say(client, ann, room, "zebracornflakes")
    r = await client.get("/api/files/search", headers=H(ann), params={"q": "zebracornflakes"})
    assert r.status_code == 200 and r.json()["hits"] == []

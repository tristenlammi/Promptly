"""Send feedback: a message from a person to this server's admins.

It is stored on the server, every admin is notified (and emailed when the
server has email), and nothing goes anywhere else. Admins read it under
Admin → Feedback; nobody else can. The thumbs on AI replies are gone.
"""
from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import select, text

from app.auth.models import User
from app.feedback.models import FeedbackMessage


@pytest.fixture
async def client(db):
    from app.main import app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def no_limit():
    from app import rate_limit

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    yield
    rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _person(db, name, role="user", disabled=False):
    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}{uuid.uuid4().hex[:6]}",
        password_hash="x",
        role=role,
        disabled=disabled,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture
def outbox(monkeypatch):
    """Notifications and emails, captured. The email task is held so the
    test runs it when it wants to."""
    import app.feedback.router as fb
    from app.mfa import smtp
    from app.notifications import dispatch

    box = {"mail": [], "push": [], "tasks": []}

    async def _send(db, *, to, subject, text_body, reply_to=None, **_):
        box["mail"].append({"to": to, "subject": subject, "body": text_body, "reply_to": reply_to})

    async def _notify(**kw):
        box["push"].append(kw)

    monkeypatch.setattr(smtp, "send_message", _send)
    monkeypatch.setattr(dispatch, "notify_user", _notify)
    monkeypatch.setattr(fb, "spawn", lambda coro, name=None: box["tasks"].append(coro))
    return box


async def _run(box):
    for coro in box["tasks"]:
        await coro
    box["tasks"].clear()


async def test_feedback_is_kept_and_every_admin_is_told(db, user, client, outbox, no_limit):
    member = await _person(db, "mia")
    second_admin = await _person(db, "ada", role="admin")
    await _person(db, "off", role="admin", disabled=True)

    r = await client.post("/api/feedback", json={"message": "  The calendar is lovely.  "}, headers=_auth(member))
    assert r.status_code == 200, r.text
    assert r.json() == {"sent": True}

    rows = (await db.execute(select(FeedbackMessage))).scalars().all()
    assert [(m.user_id, m.message, m.read_at) for m in rows] == [(member.id, "The calendar is lovely.", None)]

    # Each active admin, and only them: a notification that says who, and
    # links to Admin → Feedback. The words stay in the list.
    assert {p["user_id"] for p in outbox["push"]} == {user.id, second_admin.id}
    for p in outbox["push"]:
        assert p["title"] == f"{member.username} sent feedback"
        assert p["url"] == "/admin?tab=feedback" and p["category"] == "system_alert"
        assert "calendar" not in p["body"]

    # And an email to each admin, answerable straight to the sender.
    await _run(outbox)
    assert {m["to"] for m in outbox["mail"]} == {user.email, second_admin.email}
    for m in outbox["mail"]:
        assert m["reply_to"] == member.email
        assert "The calendar is lovely." in m["body"]


async def test_nothing_about_where_they_were_is_kept_or_sent(db, user, client, outbox, no_limit):
    member = await _person(db, "ned")
    r = await client.post(
        "/api/feedback",
        json={"message": "hello", "include_email": True, "url": "/chat/abc", "conversation_id": str(uuid.uuid4())},
        headers={**_auth(member), "Referer": "https://promptly.example.com/chat/secret-chat-id"},
    )
    assert r.status_code == 200
    cols = (
        await db.execute(
            text("select column_name from information_schema.columns where table_name = 'feedback_messages'")
        )
    ).scalars().all()
    assert sorted(cols) == ["created_at", "id", "message", "read_at", "user_id"]
    await _run(outbox)
    said = " ".join([m["body"] + m["subject"] for m in outbox["mail"]] + [str(p) for p in outbox["push"]])
    assert "secret-chat-id" not in said and "/chat/" not in said


async def test_email_trouble_is_never_the_senders_problem(db, user, client, monkeypatch, no_limit):
    import app.feedback.router as fb
    from app.mfa import smtp
    from app.notifications import dispatch

    held = []

    async def _boom(db, **kw):
        raise smtp.SmtpSendError("mail server is down")

    async def _unset(db, **kw):
        raise smtp.SmtpNotConfiguredError("no email")

    async def _notify_fails(**kw):
        raise RuntimeError("push is broken")

    monkeypatch.setattr(dispatch, "notify_user", _notify_fails)
    monkeypatch.setattr(fb, "spawn", lambda coro, name=None: held.append(coro))
    member = await _person(db, "oli")
    for failing in (_boom, _unset):
        monkeypatch.setattr(smtp, "send_message", failing)
        r = await client.post("/api/feedback", json={"message": "still works"}, headers=_auth(member))
        assert r.status_code == 200 and r.json() == {"sent": True}
        await held.pop()  # doesn't raise
    assert len((await db.execute(select(FeedbackMessage))).scalars().all()) == 2


async def test_no_outside_address_is_left_in_the_app(client, user):
    """It used to email a maintainer address by default, and hand the
    browser that address for a mailto: link."""
    from app.config import get_settings

    assert not hasattr(get_settings(), "FEEDBACK_EMAIL")
    r = await client.get("/api/feedback", headers=_auth(user))
    assert r.status_code == 405


async def test_blank_and_overlong_messages_are_refused(db, user, client, outbox, no_limit):
    for bad in ("", "   \n ", "x" * 5001):
        r = await client.post("/api/feedback", json={"message": bad}, headers=_auth(user))
        assert r.status_code == 422, bad[:10]
    r = await client.post("/api/feedback", json={"message": "x" * 5000}, headers=_auth(user))
    assert r.status_code == 200
    r = await client.post("/api/feedback", json={"message": "hi"})
    assert r.status_code == 401


async def test_six_an_hour(db, user, client, outbox, monkeypatch):
    # A Redis connection of this test's own: a pooled one left by an earlier
    # test's event loop would hang (the same reason as forms' ``limits_on``).
    from limits.aio.storage import RedisStorage
    from limits.aio.strategies import FixedWindowRateLimiter

    from app import rate_limit
    from app.redis_client import redis

    monkeypatch.setattr(rate_limit, "_limiter", FixedWindowRateLimiter(RedisStorage(rate_limit._settings.REDIS_URL)))
    monkeypatch.setattr(rate_limit._settings, "RATE_LIMIT_ENABLED", True)
    # The count is per address and lasts the hour: start from none, so a second
    # run inside the hour on the same Redis passes too.
    async for k in redis.scan_iter(match="*LIMITER/feedback/*"):
        await redis.delete(k)
    codes = []
    for i in range(7):
        r = await client.post("/api/feedback", json={"message": f"note {i}"}, headers=_auth(user))
        codes.append(r.status_code)
    assert codes == [200] * 6 + [429]
    assert len((await db.execute(select(FeedbackMessage))).scalars().all()) == 6


async def test_admins_list_mark_read_and_delete(db, user, client, outbox, no_limit):
    member = await _person(db, "pia")
    for words in ("first", "second"):
        assert (await client.post("/api/feedback", json={"message": words}, headers=_auth(member))).status_code == 200

    r = await client.get("/api/admin/feedback", headers=_auth(user))
    assert r.status_code == 200
    body = r.json()
    assert body["unread"] == 2
    assert {i["message"] for i in body["items"]} == {"first", "second"}
    for item in body["items"]:
        assert set(item) == {"id", "user_id", "username", "message", "created_at", "read"}
        assert item["username"] == member.username and item["read"] is False

    first = next(i for i in body["items"] if i["message"] == "first")
    r = await client.post(f"/api/admin/feedback/{first['id']}/read", json={"read": True}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["read"] is True
    assert (await client.get("/api/admin/feedback", headers=_auth(user))).json()["unread"] == 1
    r = await client.post(f"/api/admin/feedback/{first['id']}/read", json={"read": False}, headers=_auth(user))
    assert r.json()["read"] is False

    r = await client.delete(f"/api/admin/feedback/{first['id']}", headers=_auth(user))
    assert r.status_code == 204
    left = (await client.get("/api/admin/feedback", headers=_auth(user))).json()
    assert [i["message"] for i in left["items"]] == ["second"]
    r = await client.post(f"/api/admin/feedback/{first['id']}/read", json={"read": True}, headers=_auth(user))
    assert r.status_code == 404


async def test_only_admins_can_read_or_change_the_list(db, user, client, outbox, no_limit):
    member = await _person(db, "quin")
    other = await _person(db, "rae")
    assert (await client.post("/api/feedback", json={"message": "for the admin"}, headers=_auth(member))).status_code == 200
    row = (await db.execute(select(FeedbackMessage))).scalars().one()

    for who in (member, other):  # not even the person who wrote it
        h = _auth(who)
        assert (await client.get("/api/admin/feedback", headers=h)).status_code == 403
        assert (await client.post(f"/api/admin/feedback/{row.id}/read", json={"read": True}, headers=h)).status_code == 403
        assert (await client.delete(f"/api/admin/feedback/{row.id}", headers=h)).status_code == 403
    assert (await client.get("/api/admin/feedback")).status_code == 401
    await db.refresh(row)
    assert row.read_at is None


async def test_the_message_outlives_the_account(db, user, client, outbox, no_limit):
    member = await _person(db, "sam")
    assert (await client.post("/api/feedback", json={"message": "bye"}, headers=_auth(member))).status_code == 200
    await db.delete(member)
    await db.commit()
    items = (await client.get("/api/admin/feedback", headers=_auth(user))).json()["items"]
    assert [(i["message"], i["user_id"], i["username"]) for i in items] == [("bye", None, None)]


async def test_thumbs_on_replies_are_gone(db, user, client, conversation):
    cols = (
        await db.execute(text("select column_name from information_schema.columns where table_name = 'messages'"))
    ).scalars().all()
    assert "feedback" not in cols and "feedback_reason" not in cols

    h = _auth(user)
    r = await client.put(
        f"/api/chat/conversations/{conversation.id}/messages/{uuid.uuid4()}/feedback",
        json={"rating": "down", "reason": "wrong"}, headers=h,
    )
    assert r.status_code in (404, 405)
    for path in ("/api/admin/analytics/feedback", "/api/admin/analytics/feedback/notes"):
        assert (await client.get(path, headers=h)).status_code == 404

    from app.chat.schemas import MessageResponse

    assert not {"feedback", "feedback_reason"} & set(MessageResponse.model_fields)

"""Admin privacy, part 2 (docs/admin-privacy-audit.md, AP5-AP10).

The owner's rule: a server admin can never see another user's data, except
where that's obviously intended (the social side). Where running the
server needs an admin to act on an account, the person is told.

* AP5 (U1-U3): admin changes to an account are never silent: email (the
  old address too, for an email change), a notification, a one-time banner,
  and the person's own Recent activity. An admin can email a reset link so
  they never learn a working password.
"""
from __future__ import annotations

import re
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.auth.models import User


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


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _user(db, name, role="user"):
    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}{uuid.uuid4().hex[:6]}",
        password_hash="x",
        role=role,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture
def outbox(monkeypatch):
    """Emails and notifications, captured instead of sent."""
    from app.mfa import smtp
    from app.notifications import dispatch

    box = {"mail": [], "push": []}

    async def _send(db, *, to, subject, text_body, **_):
        box["mail"].append({"to": to, "subject": subject, "body": text_body})

    async def _notify(**kw):
        box["push"].append(kw)

    monkeypatch.setattr(smtp, "send_message", _send)
    monkeypatch.setattr(dispatch, "notify_user", _notify)
    return box


# ------------------------------------------------------------------ AP5


async def test_an_admin_password_reset_is_told_three_ways(db, client, user, outbox):
    member = await _user(db, "bea")

    r = await client.post(
        f"/api/admin/users/{member.id}/reset-password",
        headers=_auth(user), json={"password": "Temp-password-1!"},
    )
    assert r.status_code == 200

    await db.refresh(member)
    assert member.admin_notice_kind == "password_reset" and member.admin_notice_at is not None
    assert [m["to"] for m in outbox["mail"]] == [member.email]
    assert "reset your password" in outbox["mail"][0]["body"]
    assert "Temp-password" not in outbox["mail"][0]["body"]
    assert len(outbox["push"]) == 1
    push = outbox["push"][0]
    assert push["user_id"] == member.id and push["category"] == "system_alert"
    assert push["url"] == "/account/security"

    # The banner reaches them (they may only use account endpoints until
    # they choose a new password), and closing it is for every device.
    me = (await client.get("/api/auth/me", headers=_auth(member))).json()
    assert me["admin_notice_kind"] == "password_reset"
    r = await client.post("/api/auth/me/admin-notice/dismiss", headers=_auth(member))
    assert r.status_code == 200 and r.json()["admin_notice_kind"] is None
    await db.refresh(member)
    assert member.admin_notice_at is None


async def test_an_email_change_writes_to_the_old_address_too(db, client, user, outbox):
    member = await _user(db, "cal")
    old = member.email

    r = await client.patch(
        f"/api/admin/users/{member.id}", headers=_auth(user), json={"email": "taken-over@example.com"},
    )
    assert r.status_code == 200

    await db.refresh(member)
    assert member.admin_notice_kind == "email_changed"
    assert sorted(m["to"] for m in outbox["mail"]) == sorted([old, "taken-over@example.com"])
    assert all(old in m["body"] and "taken-over@example.com" in m["body"] for m in outbox["mail"])


async def test_role_and_password_edits_are_told(db, client, user, outbox):
    member = await _user(db, "dee")

    r = await client.patch(f"/api/admin/users/{member.id}", headers=_auth(user), json={"role": "admin"})
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "role_changed"
    assert "now an administrator" in outbox["push"][-1]["body"]

    r = await client.patch(
        f"/api/admin/users/{member.id}", headers=_auth(user), json={"password": "Another-temp-2!"},
    )
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "password_reset"
    assert len(outbox["push"]) == 2


async def test_an_mfa_reset_is_told(db, client, user, outbox):
    member = await _user(db, "eve")

    r = await client.post(f"/api/admin/users/{member.id}/reset-mfa", headers=_auth(user))
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "mfa_reset"
    assert outbox["mail"] and outbox["mail"][0]["to"] == member.email


async def test_an_unrelated_edit_tells_no_one(db, client, user, outbox):
    member = await _user(db, "fay")

    r = await client.patch(
        f"/api/admin/users/{member.id}", headers=_auth(user), json={"can_generate_images": False},
    )
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind is None
    assert outbox == {"mail": [], "push": []}


async def test_an_admin_editing_themselves_gets_no_banner(db, client, user, outbox):
    r = await client.patch(f"/api/admin/users/{user.id}", headers=_auth(user), json={"email": "me-again@example.com"})
    assert r.status_code == 200
    await db.refresh(user)
    assert user.admin_notice_kind is None


async def test_a_failing_mail_server_doesnt_fail_the_reset(db, client, user, monkeypatch):
    from app.mfa import smtp
    from app.notifications import dispatch

    async def _boom(*a, **k):
        raise smtp.SmtpSendError("down")

    async def _notify(**kw):
        return None

    monkeypatch.setattr(smtp, "send_message", _boom)
    monkeypatch.setattr(dispatch, "notify_user", _notify)
    member = await _user(db, "gus")

    r = await client.post(
        f"/api/admin/users/{member.id}/reset-password",
        headers=_auth(user), json={"password": "Temp-password-1!"},
    )
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "password_reset"


async def test_recent_activity_lists_only_your_own_rows(db, client, user, outbox):
    from app.auth.audit import record_event

    member = await _user(db, "hal")
    other = await _user(db, "ida")
    for uid, kind in (
        (member.id, "login_success"),
        (member.id, "token_refresh"),  # noise: not listed
        (member.id, "tool_invoked"),  # not account activity
        (other.id, "login_success"),  # someone else's
    ):
        await record_event(db, event_type=kind, user_id=uid, ip="10.0.0.1", user_agent="Mozilla/5.0 Firefox/130.0")
    await db.commit()
    await client.post(
        f"/api/admin/users/{member.id}/reset-password",
        headers=_auth(user), json={"password": "Temp-password-1!"},
    )
    await db.refresh(member)

    r = await client.get("/api/auth/security-events", headers=_auth(member))
    assert r.status_code == 200
    rows = r.json()
    assert [x["kind"] for x in rows] == ["password_reset_by_admin", "login_success"]
    assert rows[0]["by_admin"] is True and rows[0]["admin_name"] == user.username
    assert rows[1]["by_admin"] is False and rows[1]["ip"] == "10.0.0.1"
    assert "detail" not in rows[0]

    # Paging back from the oldest row shown: nothing older.
    r = await client.get(
        "/api/auth/security-events", headers=_auth(member), params={"before": rows[-1]["at"]},
    )
    assert r.json() == []

    # Signed out: nothing.
    assert (await client.get("/api/auth/security-events")).status_code == 401


async def test_an_admin_can_email_a_reset_link_instead(db, client, user, outbox):
    from app.auth.events import AuthEvent

    member = await _user(db, "jo")
    before_tv = member.token_version

    r = await client.post(f"/api/admin/users/{member.id}/send-reset-link", headers=_auth(user))
    assert r.status_code == 200

    # Nothing changed yet: their sessions and password stand until they use it.
    await db.refresh(member)
    assert member.token_version == before_tv and member.password_hash == "x"
    assert member.must_change_password is False
    assert [m["to"] for m in outbox["mail"]] == [member.email]
    body = outbox["mail"][0]["body"]
    assert "administrator" in body
    token = re.search(r"token=([\w-]+)", body).group(1)

    ev = (
        await db.execute(
            select(AuthEvent).where(AuthEvent.user_id == member.id, AuthEvent.event_type == "password_reset_requested")
        )
    ).scalar_one()
    assert str(user.id) in ev.detail

    r = await client.post("/api/auth/reset-password", json={"token": token, "new_password": "my-own-choice-77!"})
    assert r.status_code == 204
    # The admin's response never carried the link.
    assert token not in r.text


async def test_without_email_the_reset_link_is_refused_kindly(db, client, user):
    member = await _user(db, "kit")
    r = await client.post(f"/api/admin/users/{member.id}/send-reset-link", headers=_auth(user))
    assert r.status_code == 409
    assert "temporary password" in r.json()["detail"]


async def test_only_admins_send_reset_links(db, client):
    a = await _user(db, "lou")
    b = await _user(db, "max")
    r = await client.post(f"/api/admin/users/{b.id}/send-reset-link", headers=_auth(a))
    assert r.status_code == 403


async def test_a_first_sso_link_is_told_without_a_banner(db, outbox):
    from starlette.requests import Request

    from app.auth.events import AuthEvent
    from app.auth.router import _tell_sso_linked

    member = await _user(db, "ned")
    req = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": ("10.1.1.1", 1)})
    await _tell_sso_linked(db, req, member, "https://idp.example.org/realms/x")

    await db.refresh(member)
    assert member.admin_notice_kind is None  # they just signed in themselves
    assert outbox["mail"][0]["to"] == member.email
    assert "idp.example.org" in outbox["mail"][0]["body"]
    ev = (
        await db.execute(select(AuthEvent).where(AuthEvent.user_id == member.id, AuthEvent.event_type == "sso_linked"))
    ).scalar_one()
    assert ev.detail == "issuer_host=idp.example.org"

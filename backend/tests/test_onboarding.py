"""New-member onboarding: the "Send them this" email, the blank people
picker listing who's on the server, and the welcome's "say hi" host."""
from __future__ import annotations

import uuid

import pytest

from tests.test_member_defaults import _auth, _member, client  # noqa: F401


async def _plain(db, name: str, role: str = "user"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=name, password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_blank_picker_lists_people_on_the_server(db, user, client):
    new, hdr = await _member(db, client, user)
    zed = await _plain(db, "zed")
    amy = await _plain(db, "Amy")
    off = await _plain(db, "offline")
    off.disabled = True
    await db.commit()
    got = (await client.get("/api/people/search", headers=hdr)).json()["people"]
    names = [p["user"]["username"] for p in got]
    assert str(new.id) not in [p["user"]["id"] for p in got]
    assert "offline" not in names
    assert {"zed", "Amy", user.username} <= set(names)
    assert names == sorted(names, key=str.lower)
    # Only the username and picture: never an email.
    assert "@example.com" not in str(got)
    assert set(got[0]["user"]) == {"id", "username", "avatar_url", "color"}
    assert amy and zed


async def test_blank_picker_is_capped(db, user, client):
    _, hdr = await _member(db, client, user)
    for i in range(25):
        await _plain(db, f"p{i:02d}{uuid.uuid4().hex[:3]}")
    got = (await client.get("/api/people/search", headers=hdr)).json()["people"]
    assert len(got) == 20


async def test_host_is_the_first_admin(db, user, client):
    _, hdr = await _member(db, client, user)
    later = await _plain(db, "second-admin", role="admin")
    got = (await client.get("/api/people/host", headers=hdr)).json()["user"]
    assert got["id"] == str(user.id) and "email" not in got
    # The host themselves gets nobody.
    assert (await client.get("/api/people/host", headers=_auth(user))).json()["user"] is None
    assert later


@pytest.fixture
def sent(monkeypatch):
    out: list[dict] = []

    async def fake_send(db, **kw):
        out.append(kw)

    import app.mfa.smtp as smtp

    monkeypatch.setattr(smtp, "send_message", fake_send)
    return out


async def test_welcome_email_sends_the_card_text(db, user, client, sent):
    new, _ = await _member(db, client, user)
    r = await client.post(
        f"/api/admin/users/{new.id}/welcome-email", headers=_auth(user),
        json={"address": "https://promptly.example.org", "password": "Temp-pass-123!"},
    )
    assert r.status_code == 204, r.text
    (mail,) = sent
    assert mail["to"] == new.email
    body = mail["text_body"]
    assert "https://promptly.example.org" in body and new.username in body
    assert "Temp-pass-123!" in body and "Add to Home Screen" in body

    # Without a password: no password line.
    sent.clear()
    r = await client.post(
        f"/api/admin/users/{new.id}/welcome-email", headers=_auth(user), json={"address": "http://localhost:8091/"},
    )
    assert r.status_code == 204
    assert "password:" not in sent[0]["text_body"].lower()


async def test_welcome_email_guards(db, user, client, sent):
    new, hdr = await _member(db, client, user)
    url = f"/api/admin/users/{new.id}/welcome-email"
    # Members can't send it; the address must be a plain server address.
    assert (await client.post(url, headers=hdr, json={"address": "https://x.example"})).status_code == 403
    r = await client.post(url, headers=_auth(user), json={"address": "javascript:alert(1)"})
    assert r.status_code == 422
    r = await client.post(url, headers=_auth(user), json={"address": "https://evil.example/phish?x=1"})
    assert r.status_code == 422
    r = await client.post(f"/api/admin/users/{uuid.uuid4()}/welcome-email", headers=_auth(user), json={"address": "https://x.example"})
    assert r.status_code == 404
    assert sent == []


async def test_welcome_email_without_smtp_says_so(db, user, client):
    new, _ = await _member(db, client, user)
    r = await client.post(
        f"/api/admin/users/{new.id}/welcome-email", headers=_auth(user),
        json={"address": "https://promptly.example.org", "password": "Temp-pass-123!"},
    )
    assert r.status_code == 409
    assert "Temp-pass" not in r.text

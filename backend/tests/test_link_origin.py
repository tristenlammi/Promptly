"""Links Promptly sends never take their host from request headers (security
review H1: password-reset host poisoning, OIDC redirect_uri, feedback)."""
from __future__ import annotations

import re

import httpx
import pytest


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


async def _set_public(db, origins):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.public_origins = origins
    await db.commit()


@pytest.fixture
def mails(monkeypatch):
    import app.mfa.smtp as smtp

    sent: list[str] = []

    async def _send(db, *, to, subject, text_body, html_body=None, **kw):
        sent.append(text_body)

    monkeypatch.setattr(smtp, "send_message", _send)
    return sent


async def test_a_forged_forwarded_host_doesnt_change_the_reset_link(db, user, client, mails):
    await _set_public(db, ["https://promptly.example.com"])
    r = await client.post(
        "/api/auth/forgot-password",
        json={"email": user.email},
        headers={"X-Forwarded-Host": "evil.example.net", "X-Forwarded-Proto": "https", "Host": "evil.example.net"},
    )
    assert r.status_code == 202
    assert len(mails) == 1
    links = re.findall(r"https?://\S+", mails[0])
    assert links and all(l.startswith("https://promptly.example.com/reset-password?token=") for l in links)
    assert "evil" not in mails[0]


async def test_the_configured_address_in_use_is_kept(db, user, client, mails):
    await _set_public(db, ["https://promptly.example.com", "http://192.168.1.20:8087"])
    await client.post(
        "/api/auth/forgot-password", json={"email": user.email}, headers={"Host": "192.168.1.20:8087"}
    )
    assert "http://192.168.1.20:8087/reset-password?token=" in mails[0]


async def test_with_no_address_configured_only_localhost_is_trusted(db, user, client, mails, monkeypatch):
    from app.config import get_settings

    await _set_public(db, [])
    monkeypatch.setattr(get_settings(), "ALLOWED_ORIGINS", "")
    # A forged host with nothing configured: no email at all, same answer.
    r = await client.post(
        "/api/auth/forgot-password", json={"email": user.email}, headers={"X-Forwarded-Host": "evil.example.net"}
    )
    assert r.status_code == 202
    assert mails == []
    # The machine itself, on a fresh install: fine.
    await client.post("/api/auth/forgot-password", json={"email": user.email}, headers={"Host": "localhost:8087"})
    assert mails and "http://localhost:8087/reset-password?token=" in mails[0]


async def test_the_oidc_redirect_uri_ignores_forged_hosts(db, client, monkeypatch):
    import app.auth.router as auth_router
    from app.auth.oidc import OidcConfig

    await _set_public(db, ["https://promptly.example.com"])
    cfg = OidcConfig(
        issuer="https://idp.example.com", client_id="c", client_secret="s",
        scopes="openid email", button_label="SSO", satisfies_mfa=True,
    )
    seen: list[str] = []

    async def _cfg(db):
        return cfg

    async def _authorize(cfg, *, redirect_uri, state, nonce):
        seen.append(redirect_uri)
        return "https://idp.example.com/auth"

    monkeypatch.setattr(auth_router, "load_oidc_config", _cfg)
    monkeypatch.setattr(auth_router, "build_authorize_url", _authorize)
    r = await client.get("/api/auth/oidc/login", headers={"X-Forwarded-Host": "evil.example.net"})
    assert r.status_code == 302
    assert seen == ["https://promptly.example.com/api/auth/oidc/callback"]


async def test_feedback_names_the_configured_instance(db, user, client, monkeypatch):
    import app.feedback.router as fb

    await _set_public(db, ["https://promptly.example.com"])
    sent: list[str] = []

    async def _send(db, *, to, subject, text_body, reply_to=None, **kw):
        sent.append(text_body)

    monkeypatch.setattr(fb, "send_message", _send)
    from app.auth.utils import create_access_token

    headers = {
        "Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}",
        "Origin": "https://evil.example.net",
        "Host": "evil.example.net",
    }
    r = await client.post("/api/feedback", json={"message": "hello there"}, headers=headers)
    assert r.status_code == 200, r.text
    assert "Instance: https://promptly.example.com" in sent[0]
    assert "evil" not in sent[0]

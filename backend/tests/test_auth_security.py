"""SSO identity binding and MFA hardening (WP-2.2: R-139, R-140, R-141)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

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


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


# ------------------------------------------------------------------ SSO (R-140)


def test_a_missing_email_verified_claim_isnt_taken_as_verified():
    from app.auth.oidc import verified_email_from_claims

    assert verified_email_from_claims({"email": "a@example.com"}) is None
    assert verified_email_from_claims({"email": "a@example.com", "email_verified": True}) == "a@example.com"
    assert verified_email_from_claims({"email": "a@example.com"}, trust_unverified=True) == "a@example.com"


async def _sso_callback(client, monkeypatch, claims, *, satisfies_mfa=True):
    import app.auth.router as auth_router
    from app.auth.oidc import OidcConfig

    cfg = OidcConfig(
        issuer="https://idp.example.com", client_id="c", client_secret="s",
        scopes="openid email", button_label="SSO", satisfies_mfa=satisfies_mfa,
    )

    async def _cfg(db):
        return cfg

    async def _verify(cfg, *, code, redirect_uri, nonce):
        return claims

    monkeypatch.setattr(auth_router, "load_oidc_config", _cfg)
    monkeypatch.setattr(auth_router, "exchange_and_verify", _verify)
    tx = auth_router._sign_oidc_tx("st", "n", "/chat")
    client.cookies.set(auth_router._OIDC_TX_COOKIE, tx)
    return await client.get("/api/auth/oidc/callback", params={"code": "x", "state": "st"})


async def test_sso_binds_the_account_and_refuses_another_identity_with_the_same_email(db, user, client, monkeypatch):
    claims = {"iss": "https://idp.example.com", "sub": "alice-1", "email": user.email, "email_verified": True}
    r = await _sso_callback(client, monkeypatch, claims)
    assert r.status_code == 302 and "sso_error" not in r.headers["location"]
    await db.refresh(user)
    assert (user.oidc_issuer, user.oidc_subject) == ("https://idp.example.com", "alice-1")

    # Someone else at the provider who managed to claim the same address.
    intruder = {**claims, "sub": "mallory-9"}
    r = await _sso_callback(client, monkeypatch, intruder)
    assert "sso_error=linked_elsewhere" in r.headers["location"]


async def test_sso_asks_for_promptlys_second_factor(db, user, client, monkeypatch):
    from app.mfa.models import UserMfaSecret

    db.add(UserMfaSecret(user_id=user.id, method="totp", totp_secret_encrypted="x",
                         enrolled_at=datetime.now(timezone.utc)))
    user.mfa_enrolled_method = "totp"
    await db.commit()

    claims = {"iss": "https://idp.example.com", "sub": "alice-2", "email": user.email, "email_verified": True}
    r = await _sso_callback(client, monkeypatch, claims, satisfies_mfa=False)
    assert r.headers["location"] == "/login?sso=continue"

    pending = await client.post("/api/auth/oidc/pending")
    assert pending.status_code == 200 and pending.json()["status"] == "mfa_required"
    # Single use.
    assert (await client.post("/api/auth/oidc/pending")).status_code == 401


# ------------------------------------------------------------------ MFA (R-141)


async def _enrolled(db, user, password="correct horse"):
    from app.auth.utils import hash_password
    from app.mfa.models import UserMfaSecret

    user.password_hash = hash_password(password)
    user.mfa_enrolled_method = "totp"
    secret = UserMfaSecret(user_id=user.id, method="totp", totp_secret_encrypted="old-secret",
                           enrolled_at=datetime.now(timezone.utc))
    db.add(secret)
    await db.commit()
    return secret


async def test_repointing_mfa_needs_the_password(db, user, client):
    await _enrolled(db, user)

    assert (await client.post("/api/auth/mfa/setup/totp", headers=_auth(user))).status_code == 403
    ok = await client.post("/api/auth/mfa/setup/totp", headers=_auth(user), json={"password": "correct horse"})
    assert ok.status_code == 200


async def test_the_current_factor_keeps_working_while_a_new_one_is_set_up(db, user, client):
    from app.mfa.models import UserMfaSecret

    from sqlalchemy import select

    await _enrolled(db, user)
    uid = user.id
    await client.post("/api/auth/mfa/setup/totp", headers=_auth(user), json={"password": "correct horse"})

    db.expire_all()
    row = (await db.execute(select(UserMfaSecret).where(UserMfaSecret.user_id == uid))).scalar_one()
    assert row.enrolled_at is not None
    assert row.totp_secret_encrypted == "old-secret"
    assert row.pending_method == "totp" and row.pending_totp_secret_encrypted


async def test_regenerating_backup_codes_needs_the_password(db, user, client):
    await _enrolled(db, user)

    r = await client.post("/api/auth/mfa/backup-codes/regenerate", headers=_auth(user))
    assert r.status_code == 403
    r = await client.post("/api/auth/mfa/backup-codes/regenerate", headers=_auth(user),
                          json={"password": "correct horse"})
    assert r.status_code == 200 and len(r.json()["codes"]) >= 8


# ------------------------------------------------------------------ backup codes (R-139)


async def test_a_backup_code_is_found_by_lookup_and_old_codes_still_work(db, user):
    from app.auth.utils import hash_password
    from app.mfa import backup
    from app.mfa.models import MfaBackupCode

    codes = backup.generate_codes()
    await backup.replace_codes_for_user(db, user_id=user.id, plaintext_codes=codes)
    legacy = "abcd-efgh"
    db.add(MfaBackupCode(user_id=user.id, code_hash=hash_password(backup.normalise(legacy)), lookup=None))
    await db.commit()

    assert await backup.verify_and_consume(db, user_id=user.id, submitted=codes[3]) is True
    await db.commit()  # as the caller does
    assert await backup.verify_and_consume(db, user_id=user.id, submitted=codes[3]) is False
    assert await backup.verify_and_consume(db, user_id=user.id, submitted=legacy) is True


# ------------------------------------------------------------------ recovery (R-138)


async def _plain_user(db):
    from app.auth.models import User

    u = User(email=f"u-{uuid.uuid4().hex[:6]}@example.com", username=f"u{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_an_admin_can_reset_someones_mfa(db, user, client):
    member = await _plain_user(db)
    await _enrolled(db, member)
    before = member.token_version or 0

    r = await client.post(f"/api/admin/users/{member.id}/reset-mfa", headers=_auth(user))

    assert r.status_code == 200 and r.json()["mfa_enrolled_method"] is None
    await db.refresh(member)
    assert member.token_version == before + 1  # signed out everywhere


async def test_the_break_glass_command_resets_mfa(db, user):
    from app.cli import _reset_mfa

    await _enrolled(db, user)
    assert await _reset_mfa(user.username) == 0
    await db.refresh(user)
    assert user.mfa_enrolled_method is None


async def test_unreadable_secrets_are_reported_at_boot(db, provider, caplog):
    from app.auth.key_check import check_stored_secrets

    provider.api_key = "not-a-fernet-token"
    await db.commit()

    counts = await check_stored_secrets()

    assert counts["unreadable"] >= 1
    assert "SECRET_KEY_PREVIOUS" in caplog.text


# ------------------------------------------------------------------ internal emails (R-136)


async def test_an_internal_domain_email_can_sign_in_and_be_listed(db, user, client):
    """bob@corp.local was accepted by CSV import, then every response that
    re-validated it on the way out returned a 500 — including sign-in."""
    from app.auth.utils import hash_password

    user.email = f"bob-{uuid.uuid4().hex[:4]}@corp.local"
    user.password_hash = hash_password("correct horse")
    await db.commit()

    r = await client.post("/api/auth/login", json={"email": user.email, "password": "correct horse"})
    assert r.status_code == 200
    assert (await client.get("/api/auth/me", headers=_auth(user))).status_code == 200


async def test_the_form_accepts_the_same_addresses_as_import(db, user, client):
    r = await client.post(
        "/api/admin/users", headers=_auth(user),
        json={"email": "x@home.arpa", "username": f"x{uuid.uuid4().hex[:6]}", "password": "a-long-enough-password-1", "role": "user"},
    )
    assert r.status_code in (200, 201), r.text
    bad = await client.post(
        "/api/admin/users", headers=_auth(user),
        json={"email": "not an email", "username": f"y{uuid.uuid4().hex[:6]}", "password": "a-long-enough-password-1", "role": "user"},
    )
    assert bad.status_code == 422


# ------------------------------------------------------------------ CSV import (R-137)


async def test_csv_import_runs_in_the_background_and_keeps_the_passwords(db, user, client):
    import asyncio

    tag = uuid.uuid4().hex[:6]
    csv_body = (
        "email,username\n"
        f"ok-{tag}@corp.local,ok{tag}\n"
        "not-an-email,bad\n"
        f"{user.email},{user.username}\n"
    )
    r = await client.post(
        "/api/admin/users/import", headers=_auth(user),
        files={"file": ("users.csv", csv_body.encode(), "text/csv")},
    )
    assert r.status_code == 202
    job = r.json()["job_id"]

    for _ in range(50):
        state = (await client.get(f"/api/admin/users/import/{job}", headers=_auth(user))).json()
        if state["status"] != "running":
            break
        await asyncio.sleep(0.2)

    assert state["status"] == "done"
    assert [c["email"] for c in state["created"]] == [f"ok-{tag}@corp.local"]
    assert state["created"][0]["temp_password"]
    assert {s["reason"] for s in state["skipped"]} >= {"invalid email", "email or username exists"}


# ------------------------------------------------------------------ audit trail (R-145)


async def _events(db, event_type):
    from sqlalchemy import select

    from app.auth.events import AuthEvent

    return (await db.execute(select(AuthEvent).where(AuthEvent.event_type == event_type))).scalars().all()


async def test_creating_a_user_and_changing_their_role_is_audited(db, user, client):
    r = await client.post(
        "/api/admin/users", headers=_auth(user),
        json={"email": f"n-{uuid.uuid4().hex[:6]}@example.com", "username": f"n{uuid.uuid4().hex[:6]}",
              "password": "a-long-enough-password-1", "role": "user"},
    )
    new_id = r.json()["id"]
    await client.patch(f"/api/admin/users/{new_id}", headers=_auth(user), json={"role": "admin"})

    db.expire_all()
    assert any(str(e.user_id) == new_id for e in await _events(db, "user_created"))
    changed = [e for e in await _events(db, "role_changed") if str(e.user_id) == new_id]
    assert changed and "admin" in (changed[0].detail or "")


async def test_old_audit_rows_are_pruned(db, user):
    from datetime import timedelta

    from app.auth.events import AuthEvent
    from app.tasks.maintenance import prune_logs

    old = AuthEvent(user_id=user.id, event_type="login_success", identifier="x")
    db.add(old)
    await db.flush()
    old.created_at = datetime.now(timezone.utc) - timedelta(days=400)
    await db.commit()

    pruned, _ = await prune_logs()

    assert pruned >= 1


async def test_the_audit_log_exports_as_csv(db, user, client):
    r = await client.get("/api/admin/auth-events.csv", headers=_auth(user))
    assert r.status_code == 200
    assert r.text.splitlines()[0] == "time,event,user_id,identifier,ip,detail"


# ------------------------------------------------------------------ sessions (R-190, R-191)


async def test_logging_out_kills_that_refresh_token(db, user, client):
    from app.auth.utils import hash_password

    user.password_hash = hash_password("correct horse")
    await db.commit()
    r = await client.post("/api/auth/login", json={"email": user.email, "password": "correct horse"})
    assert r.status_code == 200
    stolen = dict(client.cookies)

    await client.post("/api/auth/logout")
    client.cookies.clear()
    for k, v in stolen.items():
        client.cookies.set(k, v)  # a copy of the cookie taken before sign-out

    assert (await client.post("/api/auth/refresh")).status_code == 401


async def test_signing_yourself_out_everywhere(db, user, client):
    before = user.token_version or 0
    assert (await client.post("/api/auth/logout-everywhere", headers=_auth(user))).status_code == 204
    await db.refresh(user)
    assert user.token_version == before + 1


async def test_forgot_password_link_works_once(db, user, client, monkeypatch):
    import re

    import app.mfa.smtp as smtp

    sent: list[str] = []

    async def _send(db, *, to, subject, text_body, html_body=None):
        sent.append(text_body)

    monkeypatch.setattr(smtp, "send_message", _send)

    assert (await client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})).status_code == 202
    assert sent == []  # same answer, no email
    assert (await client.post("/api/auth/forgot-password", json={"email": user.email})).status_code == 202
    token = re.search(r"token=([\w-]+)", sent[0]).group(1)

    body = {"token": token, "new_password": "a-brand-new-password-7"}
    assert (await client.post("/api/auth/reset-password", json=body)).status_code == 204
    assert (await client.post("/api/auth/reset-password", json=body)).status_code == 400
    r = await client.post("/api/auth/login", json={"email": user.email, "password": "a-brand-new-password-7"})
    assert r.status_code == 200


async def test_requiring_mfa_signs_out_people_without_it(db, user, client):
    member = await _plain_user(db)
    before_member, before_admin = member.token_version or 0, user.token_version or 0

    r = await client.patch("/api/admin/app-settings", headers=_auth(user), json={"mfa_required": True})
    assert r.status_code == 200

    await db.refresh(member)
    await db.refresh(user)
    assert member.token_version == before_member + 1
    assert user.token_version == before_admin  # the admin making the change keeps their session

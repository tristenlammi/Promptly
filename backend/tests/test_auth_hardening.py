"""Sign-in and platform hardening (WP-0.4), exercised through the real app.

Requests go through the ASGI app, so the peer is loopback (a trusted proxy)
and ``X-Real-IP`` stands in for the client address nginx resolved.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pyotp
import pytest

from app.auth.models import User
from app.auth.utils import create_access_token, create_mfa_challenge_token, encrypt_secret, hash_password
from app.files import storage

PASSWORD = "Correct-horse-9!"


@pytest.fixture
def no_rate_limits(monkeypatch):
    """The per-IP/identifier limiters would answer 429 before the lockout
    logic under test gets a say; they're tested elsewhere."""
    from app import rate_limit

    monkeypatch.setattr(rate_limit._settings, "RATE_LIMIT_ENABLED", False)


@pytest.fixture
async def client(db, no_rate_limits):
    from app.main import app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _member(db, **kw) -> User:
    u = User(email=f"m{uuid.uuid4().hex[:6]}@x.com", username=f"m{uuid.uuid4().hex[:6]}",
             password_hash=hash_password(PASSWORD), role="user", **kw)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _login(client, user, password, ip):
    return await client.post("/api/auth/login", json={"identifier": user.username, "password": password},
                              headers={"X-Real-IP": ip})


# ---------------------------------------------------------------- R-002
async def test_a_stranger_cant_lock_the_owner_out(db, user, client):
    owner = await _member(db)
    for _ in range(5):
        r = await _login(client, owner, "wrong", "203.0.113.66")
        assert r.status_code == 401
    # The attacker's address is locked out, even with the right password…
    assert (await _login(client, owner, PASSWORD, "203.0.113.66")).status_code == 401
    # …but the owner, from their own address, signs in fine.
    assert (await _login(client, owner, PASSWORD, "198.51.100.7")).status_code == 200


async def test_a_lock_never_ends_a_live_session(db, user, client):
    from datetime import datetime, timezone

    owner = await _member(db)
    token = create_access_token(owner.id, token_version=owner.token_version)
    owner.locked_at = datetime.now(timezone.utc)  # even the account-wide lock
    await db.commit()

    r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


async def test_a_spray_from_many_addresses_still_locks_the_account(db, user, client):
    from app.config import get_settings

    owner = await _member(db)
    for i in range(get_settings().ACCOUNT_LOCKOUT_THRESHOLD):
        await _login(client, owner, "wrong", f"203.0.113.{i + 1}")
    await db.refresh(owner)
    assert owner.locked_at is not None
    assert (await _login(client, owner, PASSWORD, "198.51.100.200")).status_code == 401


# ---------------------------------------------------------------- R-003
async def _mfa_user(db):
    owner = await _member(db, mfa_enrolled_method="totp")
    from app.mfa.models import UserMfaSecret

    seed = pyotp.random_base32()
    # Enrolled, as real enrolment leaves it — sign-in ignores a factor that
    # was only started (R-141).
    db.add(UserMfaSecret(user_id=owner.id, method="totp", totp_secret_encrypted=encrypt_secret(seed),
                         enrolled_at=datetime.now(timezone.utc)))
    await db.commit()
    challenge = create_mfa_challenge_token(owner.id, token_version=owner.token_version,
                                           expires_delta=timedelta(minutes=10))
    return owner, seed, challenge


async def _verify(client, challenge, code):
    return await client.post("/api/auth/mfa/verify", json={"totp_code": code},
                             headers={"Authorization": f"Bearer {challenge}"})


async def test_a_challenge_burns_after_five_wrong_codes(db, user, client):
    owner, seed, challenge = await _mfa_user(db)
    for _ in range(5):
        assert (await _verify(client, challenge, "000000")).status_code == 401
    # Even the right code no longer works on this challenge.
    r = await _verify(client, challenge, pyotp.TOTP(seed).now())
    assert r.status_code == 401 and "sign in again" in r.json()["detail"]


async def test_a_used_challenge_cant_be_replayed(db, user, client):
    owner, seed, challenge = await _mfa_user(db)
    assert (await _verify(client, challenge, pyotp.TOTP(seed).now())).status_code == 200

    r = await _verify(client, challenge, pyotp.TOTP(seed).now())
    assert r.status_code == 401


# ---------------------------------------------------------------- R-014
def test_cf_connecting_ip_from_a_client_is_ignored():
    from starlette.requests import Request

    from app.auth.audit import request_meta

    req = Request({"type": "http", "client": ("172.18.0.9", 1), "headers": [
        (b"cf-connecting-ip", b"10.6.6.6"), (b"x-real-ip", b"203.0.113.7"),
    ]})
    assert request_meta(req)[0] == "203.0.113.7"


async def test_a_share_link_password_cant_be_guessed_forever(db, user, client):
    from app.files.models import FileShareLink, UserFile

    f = UserFile(user_id=user.id, filename="a.txt", original_filename="a.txt",
                 mime_type="text/plain", size_bytes=1, storage_path="x/a.txt")
    db.add(f)
    await db.flush()
    token = secrets.token_urlsafe(16)
    db.add(FileShareLink(resource_type="file", resource_id=f.id, created_by=user.id, token=token,
                         access_mode="public", password_hash=hash_password("open-sesame")))
    await db.commit()

    for i in range(10):
        r = await client.post(f"/api/s/{token}/unlock", json={"password": f"guess{i}"},
                              headers={"X-Real-IP": f"203.0.113.{i + 1}"})
        assert r.status_code == 401
    r = await client.post(f"/api/s/{token}/unlock", json={"password": "open-sesame"},
                          headers={"X-Real-IP": "198.51.100.1"})
    assert r.status_code == 429


# ---------------------------------------------------------------- R-017
async def test_downloads_support_range_requests(db, user, client, tmp_path, monkeypatch):
    from app.files.models import UserFile

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    rel = f"u_{user.id}/{uuid.uuid4()}.bin"
    p = Path(tmp_path, rel)
    p.parent.mkdir(parents=True)
    p.write_bytes(b"0123456789")
    f = UserFile(user_id=user.id, filename="v.bin", original_filename="v.bin",
                 mime_type="application/octet-stream", size_bytes=10, storage_path=rel)
    db.add(f)
    await db.commit()
    token = create_access_token(user.id, token_version=user.token_version)

    r = await client.get(f"/api/files/{f.id}/download",
                         headers={"Authorization": f"Bearer {token}", "Range": "bytes=2-5"})

    assert r.status_code == 206 and r.content == b"2345"


# ---------------------------------------------------------------- R-030
async def test_logout_stops_this_devices_notifications(db, user, client):
    from sqlalchemy import select

    from app.auth.utils import create_refresh_token
    from app.notifications.models import PushSubscription

    db.add(PushSubscription(user_id=user.id, endpoint="https://push.example/this-device",
                            p256dh="k", auth="a"))
    db.add(PushSubscription(user_id=user.id, endpoint="https://push.example/phone",
                            p256dh="k", auth="a"))
    await db.commit()
    refresh = create_refresh_token(user.id, token_version=user.token_version)
    client.cookies.set("promptly_refresh", refresh)

    r = await client.post("/api/auth/logout", json={"push_endpoint": "https://push.example/this-device"})

    assert r.status_code == 204
    left = (await db.execute(select(PushSubscription.endpoint))).scalars().all()
    assert left == ["https://push.example/phone"]


async def test_admin_delete_user_reads_its_body_over_http(db, user, client):
    """The delete-user confirmation body must parse over real HTTP (it was
    only ever called directly in tests)."""
    victim = await _member(db)
    token = create_access_token(user.id, token_version=user.token_version)

    r = await client.request("DELETE", f"/api/admin/users/{victim.id}",
                             json={"confirm_username": "wrong"},
                             headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 400

    r = await client.request("DELETE", f"/api/admin/users/{victim.id}",
                             json={"confirm_username": victim.username, "transfers": {}},
                             headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 204

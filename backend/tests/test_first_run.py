"""Day one (WP-1.5): signing in over the LAN, claiming the admin account,
forced password changes, and creating users."""
from __future__ import annotations

import httpx
import pytest

from app.auth.cookies import cookie_secure, is_local_host, remember_request


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


# ---------------------------------------------------------------- cookies (R-254)


@pytest.mark.parametrize("host,local", [
    ("192.168.1.20:8091", True), ("10.0.0.5", True), ("localhost:8091", True), ("[::1]:8091", True),
    ("nas.local", True), ("promptly", True), ("promptly.lan:80", True),
    ("chat.example.com", False), ("203.0.113.9:8091", False),
])
def test_which_hosts_count_as_local(host, local):
    assert is_local_host(host) is local


def test_auto_leaves_secure_off_only_for_plain_http_on_the_lan(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "COOKIE_SECURE", "auto")
    remember_request("192.168.1.20:8091", https=False)
    assert cookie_secure() is False
    remember_request("chat.example.com", https=False)  # behind a TLS tunnel
    assert cookie_secure() is True
    remember_request("192.168.1.20", https=True)
    assert cookie_secure() is True
    monkeypatch.setattr(get_settings(), "COOKIE_SECURE", "true")
    remember_request("192.168.1.20:8091", https=False)
    assert cookie_secure() is True


async def test_signing_in_over_the_lan_sets_a_cookie_the_browser_keeps(db, user, client):
    from app.auth.utils import hash_password

    user.password_hash = hash_password("Correct-Horse-9!")
    await db.commit()
    lan = await client.post("/api/auth/login", json={"email": user.email, "password": "Correct-Horse-9!"},
                            headers={"Host": "192.168.1.20:8091"})
    public = await client.post("/api/auth/login", json={"email": user.email, "password": "Correct-Horse-9!"},
                               headers={"Host": "chat.example.com"})
    assert lan.status_code == public.status_code == 200
    assert "secure" not in lan.headers["set-cookie"].lower()
    assert "secure" in public.headers["set-cookie"].lower()


# ---------------------------------------------------------------- setup (R-263)


async def _no_admins(db):
    from sqlalchemy import update

    from app.auth.models import User

    await db.execute(update(User).values(role="user"))
    await db.commit()


SETUP = {"email": "owner@example.com", "username": "owner", "password": "A-good-Passw0rd!"}


async def test_setup_needs_the_code_the_installer_printed(db, client, monkeypatch):
    from app.config import get_settings

    await _no_admins(db)
    monkeypatch.setattr(get_settings(), "SETUP_TOKEN", "k3y-from-installer")

    status = await client.get("/api/auth/setup-status")
    assert status.json()["setup_code_required"] is True

    wrong = await client.post("/api/auth/setup", json={**SETUP, "setup_code": "guess"})
    assert wrong.status_code == 403
    right = await client.post("/api/auth/setup", json={**SETUP, "setup_code": "k3y-from-installer"})
    assert right.status_code == 201, right.text


async def test_without_a_code_only_the_local_network_can_claim_the_admin(db, client, monkeypatch):
    from app.config import get_settings

    await _no_admins(db)
    monkeypatch.setattr(get_settings(), "SETUP_TOKEN", None)

    stranger = await client.post("/api/auth/setup", json=SETUP, headers={"X-Real-IP": "203.0.113.50"})
    assert stranger.status_code == 403
    neighbour = await client.post("/api/auth/setup", json=SETUP, headers={"X-Real-IP": "192.168.1.30"})
    assert neighbour.status_code == 201, neighbour.text


# ---------------------------------------------------------------- password change (R-259)


async def test_a_user_who_must_change_their_password_can_do_nothing_else(db, user, client):
    from app.auth.utils import hash_password

    user.password_hash = hash_password("Temp-Passw0rd!")
    user.must_change_password = True
    await db.commit()

    me = await client.get("/api/auth/me", headers=_auth(user))
    assert me.status_code == 200 and me.json()["must_change_password"] is True
    blocked = await client.get("/api/chat/conversations", headers=_auth(user))
    assert blocked.status_code == 403 and blocked.json()["detail"] == "password_change_required"

    changed = await client.post("/api/auth/me/password", headers=_auth(user),
                                json={"current_password": "Temp-Passw0rd!", "new_password": "My-Own-Passw0rd!"})
    assert changed.status_code == 200, changed.text
    token = changed.json()["access_token"]
    ok = await client.get("/api/chat/conversations", headers={"Authorization": f"Bearer {token}"})
    assert ok.status_code == 200


# ---------------------------------------------------------------- create user (R-259/R-260)


async def test_creating_a_user_keeps_the_capability_toggles_and_flags_the_password(db, user, client):
    from app.auth.models import User

    r = await client.post("/api/admin/users", headers=_auth(user), json={
        "email": "new.person@example.com", "username": "newperson", "password": "Handed-0ver-Pw!",
        "can_generate_images": False, "can_execute_code": False,
    })
    assert r.status_code in (200, 201), r.text
    from sqlalchemy import select

    created = (await db.execute(select(User).where(User.username == "newperson"))).scalar_one()
    assert created.can_generate_images is False
    assert created.can_execute_code is False
    assert created.must_change_password is True


# ---------------------------------------------------------------- embedder (R-253)


async def test_local_embedding_isnt_saved_when_there_is_no_local_ollama(db, user, client, monkeypatch):
    from app.custom_models import router as cm

    async def _none(base):
        return None

    monkeypatch.setattr(cm, "_ollama_installed_models", _none)

    status = await client.get("/api/admin/custom-models/local-embedding-status", headers=_auth(user))
    assert status.json()["ollama_reachable"] is False
    r = await client.post("/api/admin/custom-models/bootstrap-local-embedding", headers=_auth(user))
    assert r.status_code == 409
    assert "no local Ollama" in r.json()["detail"]

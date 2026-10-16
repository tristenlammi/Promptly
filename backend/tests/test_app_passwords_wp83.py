"""App passwords (WP-8.3, Part C §5.7): one per syncing device, shown once,
stored as a hash, scoped, revocable on its own — and the only thing Basic
auth accepts."""
from __future__ import annotations

import base64
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


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _basic(username: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


async def _person(db, name, **kw):
    from app.auth.models import User

    row = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
               password_hash="x", role="user", **kw)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _make(client, user, name="Sam's iPhone", scopes=("dav:read", "dav:write")):
    r = await client.post("/api/auth/app-passwords", json={"name": name, "scopes": list(scopes)}, headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()


def test_the_token_format_catches_typos_before_any_lookup():
    from app.auth.app_passwords import PREFIX, new_token, well_formed

    t = new_token()
    assert t.startswith(PREFIX) and len(t) == 40 and well_formed(t)
    i = 10
    typo = t[:i] + ("a" if t[i] != "a" else "b") + t[i + 1:]
    assert not well_formed(typo)
    assert not well_formed("ghp_" + t[4:]) and not well_formed("hunter2") and not well_formed(t + "x")


@pytest.mark.asyncio
async def test_a_device_gets_a_password_once_and_only_its_hash_is_kept(client, db, user):
    from app.auth.app_passwords import AppPassword, token_hash

    made = await _make(client, user)
    assert made["password"].startswith("pmt_") and made["username"] == user.username
    assert made["hint"] == made["password"][:8] + "…" and made["scopes"] == ["dav:read", "dav:write"]
    row = await db.get(AppPassword, uuid.UUID(made["id"]))
    assert row.token_hash == token_hash(made["password"]) and made["password"] not in (row.hint or "")

    listed = (await client.get("/api/auth/app-passwords", headers=_auth(user))).json()
    assert [d["id"] for d in listed] == [made["id"]] and "password" not in listed[0]

    bad = await client.post("/api/auth/app-passwords", json={"name": "x", "scopes": ["admin"]}, headers=_auth(user))
    assert bad.status_code == 422
    blank = await client.post("/api/auth/app-passwords", json={"name": "   ", "scopes": ["upload"]}, headers=_auth(user))
    assert blank.status_code == 422


@pytest.mark.asyncio
async def test_only_app_passwords_work_and_revoking_cuts_off_at_once(client, db, user):
    from app.auth.basic import user_from_basic

    made = await _make(client, user)
    pw = made["password"]
    who = await user_from_basic(db, _basic(user.username, pw), scope="dav:read", ip="198.51.100.1")
    assert who.id == user.id
    # The email works as the username too.
    assert (await user_from_basic(db, _basic(user.email.upper(), pw), scope="dav:write", ip="198.51.100.1")).id == user.id

    from fastapi import HTTPException

    async def refused(header, scope="dav:read"):
        with pytest.raises(HTTPException) as e:
            await user_from_basic(db, header, scope=scope, ip="198.51.100.1")
        return e.value

    # Not the account password, ever; nor someone else's username.
    e = await refused(_basic(user.username, "the-account-password"))
    assert e.status_code == 401 and e.headers["WWW-Authenticate"].startswith("Basic")
    pal = await _person(db, "pal")
    assert (await refused(_basic(pal.username, pw))).status_code == 401
    # A scope it wasn't given.
    assert (await refused(_basic(user.username, pw), scope="upload")).status_code == 403
    # No header at all: a challenge.
    assert (await refused(None)).status_code == 401

    r = await client.delete(f"/api/auth/app-passwords/{made['id']}", headers=_auth(user))
    assert r.status_code == 204
    assert (await refused(_basic(user.username, pw))).status_code == 401
    assert (await client.get("/api/auth/app-passwords", headers=_auth(user))).json() == []
    # Not yours to revoke.
    other = await _make(client, user, name="Laptop")
    assert (await client.delete(f"/api/auth/app-passwords/{other['id']}", headers=_auth(pal))).status_code == 404


@pytest.mark.asyncio
async def test_a_disabled_account_s_devices_stop_and_use_is_recorded(client, db, user):
    from app.auth.app_passwords import AppPassword
    from app.auth.basic import user_from_basic
    from app.auth.events import EVENT_APP_PASSWORD_CREATED, EVENT_APP_PASSWORD_FAILED, AuthEvent
    from app.auth.models import User

    made = await _make(client, user)
    await user_from_basic(db, _basic(user.username, made["password"]), scope="dav:read", ip="192.0.2.44")
    row = await db.get(AppPassword, uuid.UUID(made["id"]), populate_existing=True)
    assert row.last_used_at is not None and row.last_used_ip == "192.0.2.44"

    me = await db.get(User, user.id)
    me.disabled = True
    await db.commit()
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        await user_from_basic(db, _basic(user.username, made["password"]), scope="dav:read", ip="192.0.2.44")
    assert e.value.status_code == 401
    kinds = set((await db.execute(select(AuthEvent.event_type))).scalars())
    assert {EVENT_APP_PASSWORD_CREATED, EVENT_APP_PASSWORD_FAILED} <= kinds


@pytest.mark.asyncio
async def test_too_many_wrong_ones_from_an_address_are_slowed_down(db, user, monkeypatch):
    from fastapi import HTTPException

    from app import rate_limit
    from app.auth.app_passwords import new_token
    from app.auth.basic import user_from_basic

    monkeypatch.setattr(rate_limit._settings, "RATE_LIMIT_ENABLED", True)
    ip = f"203.0.113.{uuid.uuid4().int % 250}"
    codes = []
    for _ in range(12):
        with pytest.raises(HTTPException) as e:
            await user_from_basic(db, _basic(user.username, new_token()), scope="dav:read", ip=ip)
        codes.append(e.value.status_code)
    assert codes[:10] == [401] * 10 and codes[-1] == 429


@pytest.mark.asyncio
async def test_a_device_can_start_a_big_upload_with_its_password(client, db, user, monkeypatch, tmp_path):
    from app.config import get_settings
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(get_settings(), "TUS_HOOK_SECRET", None)
    uploads = await _make(client, user, name="Backup script", scopes=("upload",))
    dav_only = await _make(client, user, name="Finder", scopes=("dav:read",))

    def event(pw):
        return {"Type": "pre-create", "Event": {
            "Upload": {"ID": "", "Size": 5, "SizeIsDeferred": False, "Offset": 0, "IsPartial": False, "IsFinal": False,
                       "MetaData": {"filename": "log.txt", "scope": "mine"}, "PartialUploads": None, "Storage": None},
            "HTTPRequest": {"Method": "POST", "URI": "/api/files/tus/", "RemoteAddr": "x",
                            "Header": {"Authorization": [_basic(user.username, pw)], "X-Real-Ip": ["198.51.100.9"]}},
        }}

    ok = (await client.post("/api/internal/tus-hook", json=event(uploads["password"]))).json()
    assert "ChangeFileInfo" in ok
    no = (await client.post("/api/internal/tus-hook", json=event(dav_only["password"]))).json()
    assert no["RejectUpload"] is True and no["HTTPResponse"]["StatusCode"] == 403


@pytest.mark.asyncio
async def test_a_cap_on_devices(client, db, user, monkeypatch):
    from app.auth import app_passwords_router

    monkeypatch.setattr(app_passwords_router, "MAX_PER_USER", 2)
    await _make(client, user, name="One")
    await _make(client, user, name="Two")
    r = await client.post("/api/auth/app-passwords", json={"name": "Three", "scopes": ["upload"]}, headers=_auth(user))
    assert r.status_code == 409

"""The Android app showing notifications itself (0455): a linked phone
registers with its app password; it's a subscription like any other (on by
default, its own switch); Chrome on the same phone goes quiet while the app's
subscription exists and carries on if it goes; nobody can register for
someone else, or point a phone's "address" somewhere that isn't a push service."""
from __future__ import annotations

import base64
import hashlib
import json
import uuid

import httpx
import pytest
from sqlalchemy import select

PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
FCM = "https://fcm.googleapis.com/fcm/send/"


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


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
def sent(monkeypatch):
    import app.notifications.dispatch as d

    out: list[str] = []

    def fake_send_one(**kw):
        json.loads(kw["payload_json"])
        out.append(kw["endpoint"])

    async def fake_vapid(db):
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "_send_one", fake_send_one)
    monkeypatch.setattr(d, "_vapid", fake_vapid)
    return out


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user", settings={})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def phone_of(client, user, scopes=("upload", "widgets")) -> dict:
    """A linked phone's sign-in: its app password, as Basic."""
    r = await client.post("/api/auth/app-passwords", json={"name": "Pixel 9", "scopes": list(scopes)}, headers=H(user))
    assert r.status_code == 201, r.text
    j = r.json()
    return {"Authorization": "Basic " + base64.b64encode(f"{j['username']}:{j['password']}".encode()).decode()}


async def register(client, phone: dict, endpoint: str, **extra):
    return await client.post(
        "/api/notifications/native",
        headers=phone,
        json={"endpoint": endpoint, "keys": {"p256dh": "k", "auth": "a"}, "device": "Google Pixel 9", "version": "1.10.0", **extra},
    )


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


async def test_a_linked_phone_registers_and_starts_on(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "ann")
    phone = await phone_of(client, u)

    r = await register(client, phone, FCM + "abc")

    assert r.status_code == 201, r.text
    row = r.json()
    assert row["enabled"] is True and row["mobile"] is True and row["app"] is True
    assert row["label"] == "Google Pixel 9" and "endpoint" not in row
    await send_test_push(u.id)
    assert sent == [FCM + "abc"]


async def test_registering_again_keeps_one_row_and_the_owners_switch(client, db):
    u = await mk_user(db, "bea")
    phone = await phone_of(client, u)
    first = (await register(client, phone, FCM + "abc")).json()
    off = await client.patch(f"/api/notifications/subscriptions/{first['id']}", headers=H(u), json={"enabled": False})
    assert off.status_code == 200

    again = (await register(client, phone, FCM + "abc")).json()

    assert again["id"] == first["id"] and again["enabled"] is False
    assert len((await client.get("/api/notifications/subscriptions", headers=H(u))).json()) == 1


async def test_a_new_address_replaces_the_old_one(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "cal")
    phone = await phone_of(client, u)
    await register(client, phone, FCM + "old")

    r = await register(client, phone, FCM + "new", replaces=FCM + "old")

    assert r.status_code == 201
    await send_test_push(u.id)
    assert sent == [FCM + "new"]


async def test_needs_the_phones_own_sign_in(client, db):
    u = await mk_user(db, "dee")

    none = await client.post("/api/notifications/native", json={"endpoint": FCM + "x", "keys": {"p256dh": "k", "auth": "a"}})
    bad = await register(client, {"Authorization": "Basic " + base64.b64encode(b"dee:pmt_nope").decode()}, FCM + "x")
    # A browser session isn't a phone: the page can't plant an "app" row.
    page = await register(client, H(u), FCM + "x")

    assert none.status_code == 401 and bad.status_code == 401 and page.status_code == 401


async def test_only_a_push_service_address_is_taken(client, db):
    u = await mk_user(db, "eve")
    phone = await phone_of(client, u)

    for endpoint in ("http://10.0.0.5/internal", "https://example.com/hook", "https://fcm.googleapis.com.evil.example/x"):
        r = await register(client, phone, endpoint)
        assert r.status_code == 400, endpoint


async def test_chrome_on_the_same_phone_goes_quiet_while_the_app_is_there(client, db, sent):
    from app.notifications.dispatch import send_test_push
    from app.notifications.models import PushSubscription

    u = await mk_user(db, "fay")
    phone = await phone_of(client, u)
    app_row = (await register(client, phone, FCM + "app")).json()
    # Chrome on that phone, told by the app's launcher which app subscription covers it.
    chrome = await client.post(
        "/api/notifications/subscriptions", headers=H(u),
        json={"endpoint": FCM + "chrome", "keys": {"p256dh": "k", "auth": "a"}, "user_agent": PHONE, "covered_by": sha(FCM + "app")},
    )
    assert chrome.status_code == 201, chrome.text
    # Another phone with only a browser: still gets everything.
    await client.post(
        "/api/notifications/subscriptions", headers=H(u),
        json={"endpoint": FCM + "other", "keys": {"p256dh": "k", "auth": "a"}, "user_agent": PHONE},
    )

    await send_test_push(u.id)
    assert sorted(sent) == [FCM + "app", FCM + "other"]
    listed = {d["id"]: d for d in (await client.get("/api/notifications/subscriptions", headers=H(u))).json()}
    assert listed[chrome.json()["id"]]["covered"] is True and listed[app_row["id"]]["covered"] is False

    # The app's subscription goes (unlinked, uninstalled): Chrome carries on by itself.
    sent.clear()
    gone = await client.post("/api/notifications/native/gone", headers=phone, json={"endpoint": FCM + "app"})
    assert gone.status_code == 204
    await send_test_push(u.id)
    assert sorted(sent) == [FCM + "chrome", FCM + "other"]
    left = (await db.execute(select(PushSubscription).where(PushSubscription.user_id == u.id))).scalars().all()
    assert len(left) == 2


async def test_the_apps_switch_is_the_phones_switch(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "gus")
    phone = await phone_of(client, u)
    app_row = (await register(client, phone, FCM + "app")).json()
    await client.post(
        "/api/notifications/subscriptions", headers=H(u),
        json={"endpoint": FCM + "chrome", "keys": {"p256dh": "k", "auth": "a"}, "user_agent": PHONE, "covered_by": sha(FCM + "app")},
    )

    await client.patch(f"/api/notifications/subscriptions/{app_row['id']}", headers=H(u), json={"enabled": False})
    await send_test_push(u.id)

    # Off means off: Chrome doesn't take over a phone you switched off.
    assert sent == []


async def test_cover_is_only_for_an_app_subscription_you_have(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "hal")
    other = await mk_user(db, "ivy")
    await register(client, await phone_of(client, other), FCM + "theirs")

    made_up = await client.post(
        "/api/notifications/subscriptions", headers=H(u),
        json={"endpoint": FCM + "chrome", "keys": {"p256dh": "k", "auth": "a"}, "user_agent": PHONE, "covered_by": sha(FCM + "theirs")},
    )

    assert made_up.status_code == 201 and made_up.json()["covered"] is False
    await send_test_push(u.id)
    assert sent == [FCM + "chrome"]


async def test_a_page_marks_and_clears_its_row_later(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "jan")
    phone = await phone_of(client, u)
    await register(client, phone, FCM + "app")
    chrome = (await client.post(
        "/api/notifications/subscriptions", headers=H(u),
        json={"endpoint": FCM + "chrome", "keys": {"p256dh": "k", "auth": "a"}, "user_agent": PHONE},
    )).json()

    await client.patch(f"/api/notifications/subscriptions/{chrome['id']}", headers=H(u), json={"covered_by": sha(FCM + "app")})
    await send_test_push(u.id)
    assert sent == [FCM + "app"]

    sent.clear()
    await client.patch(f"/api/notifications/subscriptions/{chrome['id']}", headers=H(u), json={"covered_by": ""})
    await send_test_push(u.id)
    assert sorted(sent) == [FCM + "app", FCM + "chrome"]


async def test_a_reinstalled_app_replaces_its_own_old_row(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "kim")
    phone = await phone_of(client, u)
    old = (await register(client, phone, FCM + "before", install="0a1b2c3d4e5f")).json()
    await client.patch(f"/api/notifications/subscriptions/{old['id']}", headers=H(u), json={"enabled": False})
    # Another phone of the same model on the same account: left alone.
    await register(client, phone, FCM + "second-phone", install="ffffffffffff")

    # Reinstalled: a new address, and no memory of the old one to say "replaces".
    new = (await register(client, phone, FCM + "after", install="0a1b2c3d4e5f")).json()

    rows = (await client.get("/api/notifications/subscriptions", headers=H(u))).json()
    assert len(rows) == 2 and old["id"] not in {r["id"] for r in rows}
    # The owner had switched that phone off: it stays off.
    assert new["enabled"] is False
    await send_test_push(u.id)
    assert sent == [FCM + "second-phone"]


async def test_an_install_id_that_isnt_one_is_ignored(client, db):
    u = await mk_user(db, "lee")
    phone = await phone_of(client, u)
    await register(client, phone, FCM + "a", install="not-hex!!")
    await register(client, phone, FCM + "b", install="not-hex!!")

    assert len((await client.get("/api/notifications/subscriptions", headers=H(u))).json()) == 2

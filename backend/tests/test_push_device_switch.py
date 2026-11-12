"""Each device's own notification switch (0442): phones and tablets start
on, anything else starts off; a device that's off gets nothing, whatever the
category; the switch is changed from the device list; setting a device up
again never flips a switch its owner chose."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from sqlalchemy import select

PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"
LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"


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
    """The endpoint of every push that reached the (fake) push service."""
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


async def set_up(client, user, endpoint: str, user_agent: str) -> dict:
    r = await client.post(
        "/api/notifications/subscriptions",
        headers=H(user),
        json={"endpoint": endpoint, "keys": {"p256dh": "k", "auth": "a"}, "user_agent": user_agent},
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.parametrize(
    ("user_agent", "mobile"),
    [
        (PHONE, True),
        (ANDROID_TABLET, True),
        (IPHONE, True),
        (IPAD_AS_MAC, True),
        (WINDOWS, False),
        (MAC, False),
        (LINUX_FIREFOX, False),
        (None, False),
        ("", False),
    ],
)
def test_which_devices_count_as_phones_and_tablets(user_agent, mobile):
    from app.notifications.devices import is_mobile, starts_on

    assert is_mobile(user_agent) is mobile
    assert starts_on(user_agent) is mobile


async def test_a_phone_starts_on_and_a_computer_starts_off(client, db):
    u = await mk_user(db, "ann")
    phone = await set_up(client, u, "https://push.invalid/phone", PHONE)
    pc = await set_up(client, u, "https://push.invalid/pc", WINDOWS)

    assert phone["enabled"] is True and phone["mobile"] is True
    assert pc["enabled"] is False and pc["mobile"] is False

    listed = (await client.get("/api/notifications/subscriptions", headers=H(u))).json()
    assert {d["id"]: d["enabled"] for d in listed} == {phone["id"]: True, pc["id"]: False}


async def test_the_list_lets_a_page_find_its_own_row_without_the_endpoint(client, db):
    import hashlib

    u = await mk_user(db, "bea")
    endpoint = "https://push.invalid/mine"
    row = await set_up(client, u, endpoint, PHONE)

    assert row["endpoint_hash"] == hashlib.sha256(endpoint.encode()).hexdigest()
    assert "endpoint" not in row


async def test_only_devices_that_are_switched_on_get_a_push(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "cal")
    await set_up(client, u, "https://push.invalid/phone", PHONE)
    await set_up(client, u, "https://push.invalid/pc", WINDOWS)

    outcome = await send_test_push(u.id)

    assert sent == ["https://push.invalid/phone"]
    assert outcome["delivered"] == 1 and outcome["failed"] == 0


async def test_nothing_is_sent_when_every_device_is_off(client, db, sent):
    u = await mk_user(db, "dee")
    await set_up(client, u, "https://push.invalid/pc", WINDOWS)

    r = await client.post("/api/notifications/test", headers=H(u))

    assert r.status_code == 200, r.text
    assert r.json() == {"sent": 0, "failed": 0, "removed": 0}
    assert sent == []


async def test_the_switch_turns_a_computer_on_and_a_phone_off(client, db, sent):
    from app.notifications.dispatch import send_test_push

    u = await mk_user(db, "eve")
    phone = await set_up(client, u, "https://push.invalid/phone", PHONE)
    pc = await set_up(client, u, "https://push.invalid/pc", WINDOWS)

    r = await client.patch(f"/api/notifications/subscriptions/{pc['id']}", headers=H(u), json={"enabled": True})
    assert r.status_code == 200 and r.json()["enabled"] is True
    r = await client.patch(f"/api/notifications/subscriptions/{phone['id']}", headers=H(u), json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False

    await send_test_push(u.id)
    assert sent == ["https://push.invalid/pc"]


async def test_renaming_a_device_leaves_its_switch_alone(client, db):
    u = await mk_user(db, "fay")
    pc = await set_up(client, u, "https://push.invalid/pc", WINDOWS)

    r = await client.patch(f"/api/notifications/subscriptions/{pc['id']}", headers=H(u), json={"label": "Study PC"})

    assert r.status_code == 200
    assert r.json()["label"] == "Study PC" and r.json()["enabled"] is False


async def test_setting_a_device_up_again_keeps_the_switch_its_owner_chose(client, db):
    u = await mk_user(db, "gus")
    pc = await set_up(client, u, "https://push.invalid/pc", WINDOWS)
    await client.patch(f"/api/notifications/subscriptions/{pc['id']}", headers=H(u), json={"enabled": True})
    phone = await set_up(client, u, "https://push.invalid/phone", PHONE)
    await client.patch(f"/api/notifications/subscriptions/{phone['id']}", headers=H(u), json={"enabled": False})

    # The app re-registers the same browser every so often.
    pc_again = await set_up(client, u, "https://push.invalid/pc", WINDOWS)
    phone_again = await set_up(client, u, "https://push.invalid/phone", PHONE)

    assert pc_again["id"] == pc["id"] and pc_again["enabled"] is True
    assert phone_again["id"] == phone["id"] and phone_again["enabled"] is False


async def test_nobody_can_flip_someone_elses_switch(client, db):
    from app.notifications.models import PushSubscription

    owner = await mk_user(db, "hal")
    other = await mk_user(db, "ivy")
    pc = await set_up(client, owner, "https://push.invalid/pc", WINDOWS)

    r = await client.patch(f"/api/notifications/subscriptions/{pc['id']}", headers=H(other), json={"enabled": True})

    assert r.status_code == 404
    row = (await db.execute(select(PushSubscription).where(PushSubscription.id == uuid.UUID(pc["id"])))).scalar_one()
    await db.refresh(row)
    assert row.enabled is False


async def test_the_update_switches_off_computers_that_were_already_set_up(db):
    """The data step of migration 0442, run against rows as they were
    before it (every switch on)."""
    from sqlalchemy import text

    from app.notifications.models import PushSubscription

    u = await mk_user(db, "jon")
    agents = {"phone": PHONE, "tablet": ANDROID_TABLET, "iphone": IPHONE, "pc": WINDOWS, "mac": MAC, "unknown": None}
    for name, agent in agents.items():
        db.add(PushSubscription(user_id=u.id, endpoint=f"https://push.invalid/{name}", p256dh="k", auth="a",
                                user_agent=agent, enabled=True))
    await db.commit()

    import importlib.util
    from pathlib import Path

    path = next((Path(__file__).resolve().parent.parent / "alembic" / "versions").glob("*_0442_push_device_switch.py"))
    spec = importlib.util.spec_from_file_location("m0442", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    await db.execute(
        text(
            "UPDATE push_subscriptions SET enabled = false "
            "WHERE user_agent IS NULL OR user_agent !~* :mobile"
        ).bindparams(mobile=module._MOBILE)
    )
    await db.commit()

    rows = (await db.execute(select(PushSubscription).where(PushSubscription.user_id == u.id))).scalars().all()
    for row in rows:
        await db.refresh(row)
    assert {r.endpoint.rsplit("/", 1)[1]: r.enabled for r in rows} == {
        "phone": True, "tablet": True, "iphone": True, "pc": False, "mac": False, "unknown": False,
    }

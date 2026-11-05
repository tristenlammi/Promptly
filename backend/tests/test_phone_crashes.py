"""Crashes from the Android app land in Admin → Console, once each, with nothing secret."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

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


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _report(key="a", **over):
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    return {
        "key": key,
        "at": at.isoformat(),
        "kind": "crash",
        "thread": "main",
        "message": "java.lang.IllegalStateException: no surface",
        "stack": "at org.promptly.sync.maps.Nav.go(Nav.kt:3)",
        **over,
    }


def _body(*reports):
    return {"app_version": "1.4.2", "device": "Pixel 8", "android": "16", "reports": list(reports)}


async def test_a_crash_shows_in_the_console_once_and_when_it_happened(client, user):
    h = _auth(user)
    first = await client.post("/api/devices/crashes", headers=h, json=_body(_report()))
    assert first.json() == {"added": 1}
    # The phone wasn't told it arrived, and sends it again.
    assert (await client.post("/api/devices/crashes", headers=h, json=_body(_report()))).json() == {"added": 0}
    groups = (await client.get("/api/admin/errors/groups", headers=h, params={"source": "android"})).json()
    assert len(groups) == 1
    g = groups[0]
    assert g["exception_class"] == "java.lang.IllegalStateException" and g["occurrences"] == 1
    assert datetime.now(timezone.utc) - datetime.fromisoformat(g["last_seen_at"]) > timedelta(hours=1)
    events = (await client.get(f"/api/admin/errors/groups/{g['fingerprint']}/events", headers=h)).json()
    assert events[0]["route"] == "Reported by Android app 1.4.2 · Pixel 8 · Android 16"
    assert "Nav.kt:3" in (await client.get(f"/api/admin/errors/{events[0]['id']}", headers=h)).json()["stack"]


async def test_the_same_fault_groups_and_the_source_filter_keeps_them_apart(client, db, user):
    from app.observability.models import ErrorEvent

    h = _auth(user)
    db.add(ErrorEvent(fingerprint="server", level="ERROR", logger="promptly.x", message="server fault"))
    await db.commit()
    await client.post(
        "/api/devices/crashes",
        headers=h,
        json=_body(
            _report("a", message="java.lang.NullPointerException: at 0x7f001"),
            _report("b", message="java.lang.NullPointerException: at 0x7f999"),
        ),
    )
    phone = (await client.get("/api/admin/errors/groups", headers=h, params={"source": "android"})).json()
    assert [g["occurrences"] for g in phone] == [2]
    assert any(g["fingerprint"] == "server" for g in (await client.get("/api/admin/errors/groups", headers=h)).json())


async def test_nothing_secret_is_kept(client, db, user):
    from sqlalchemy import select

    from app.observability.models import ErrorEvent

    await client.post(
        "/api/devices/crashes",
        headers=_auth(user),
        json=_body(
            _report(
                message="java.io.IOException: GET /x?token=abc123&code=999 failed",
                stack="password=hunter2\nAuthorization: Basic dXNlcjpwYXNz\nat a.b(c.kt:1)",
            )
        ),
    )
    row = (await db.execute(select(ErrorEvent).where(ErrorEvent.logger == "android"))).scalars().one()
    for secret in ("abc123", "999", "hunter2", "dXNlcjpwYXNz"):
        assert secret not in row.message and secret not in row.stack
    assert "c.kt:1" in row.stack


async def test_a_broken_phone_cant_fill_the_table(client, db, user):
    from sqlalchemy import func, select

    from app.observability import phone
    from app.observability.models import ErrorEvent

    h = _auth(user)
    old = phone._DAILY_LIMIT
    phone._DAILY_LIMIT = 3
    try:
        out = await client.post("/api/devices/crashes", headers=h, json=_body(*[_report(str(i)) for i in range(5)]))
    finally:
        phone._DAILY_LIMIT = old
    assert out.json() == {"added": 3}
    assert await db.scalar(select(func.count(ErrorEvent.id)).where(ErrorEvent.logger == "android")) == 3


async def test_a_wild_date_doesnt_move_it_and_signing_in_is_needed(client, db, user):
    from sqlalchemy import select

    from app.observability.models import ErrorEvent

    assert (await client.post("/api/devices/crashes", json=_body(_report()))).status_code == 401
    await client.post("/api/devices/crashes", headers=_auth(user), json=_body(_report(at="2031-01-01T00:00:00+00:00")))
    row = (await db.execute(select(ErrorEvent).where(ErrorEvent.logger == "android"))).scalars().one()
    assert row.created_at.year < 2031 and row.extra["happened_at"].startswith("2031")


async def test_only_an_admin_sees_them(client, db, user):
    from app.auth.models import User

    other = User(email="p@example.com", username="plainphone", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    await db.refresh(other)
    h = _auth(other)
    assert (await client.post("/api/devices/crashes", headers=h, json=_body(_report()))).json() == {"added": 1}
    assert (await client.get("/api/admin/errors/groups", headers=h)).status_code == 403


@pytest.fixture
def told(monkeypatch):
    from app.notifications import dispatch

    sent = []

    async def fake(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake)
    return sent


async def test_admins_hear_about_a_new_fault_once_and_again_if_it_returns(client, db, user, told):
    from app.auth.models import User

    plain = User(email="plain@example.com", username="plainuser", password_hash="x", role="user")
    db.add(plain)
    await db.commit()
    await db.refresh(plain)
    h = _auth(plain)
    await client.post("/api/devices/crashes", headers=h, json=_body(_report("a")))
    assert {t["user_id"] for t in told} == {user.id}
    alert = told[0]
    assert alert["category"] == "system_alert" and alert["url"] == "/admin?tab=console&view=errors&source=android"
    assert "IllegalStateException" in alert["body"] and "plainuser on Pixel 8" in alert["body"]

    # The same fault again, and the same report again: no more noise.
    told.clear()
    await client.post("/api/devices/crashes", headers=h, json=_body(_report("b")))
    await client.post("/api/devices/crashes", headers=h, json=_body(_report("a")))
    assert told == []

    # Marked resolved, then back: that's news.
    groups = (await client.get("/api/admin/errors/groups", headers=_auth(user), params={"source": "android"})).json()
    done = await client.post(f"/api/admin/errors/groups/{groups[0]['fingerprint']}/resolve", headers=_auth(user))
    assert done.status_code < 300, done.text
    await client.post("/api/devices/crashes", headers=h, json=_body(_report("c")))
    assert len(told) == 1


async def test_a_backlog_of_faults_doesnt_flood_admins(client, user, told):
    reports = [_report(str(i), message=f"java.lang.Error{i}Error: x") for i in range(6)]
    assert (await client.post("/api/devices/crashes", headers=_auth(user), json=_body(*reports))).json() == {"added": 6}
    assert len(told) == 4 and "3 more" in told[-1]["body"]


async def test_a_failed_alert_doesnt_lose_the_report(client, db, user, monkeypatch):
    from sqlalchemy import func, select

    from app.notifications import dispatch
    from app.observability.models import ErrorEvent

    async def broken(**kw):
        raise RuntimeError("no push today")

    monkeypatch.setattr(dispatch, "notify_user", broken)
    assert (await client.post("/api/devices/crashes", headers=_auth(user), json=_body(_report()))).json() == {"added": 1}
    assert await db.scalar(select(func.count(ErrorEvent.id)).where(ErrorEvent.logger == "android")) == 1

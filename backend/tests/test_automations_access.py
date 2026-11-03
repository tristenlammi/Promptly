"""Automations are off by default and turned on per account by an admin;
the Today page layout (hidden cards, order) saves to your settings."""
from __future__ import annotations

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


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _member(db, client, admin, **extra):
    from app.auth.models import User

    name = f"m{uuid.uuid4().hex[:6]}"
    r = await client.post(
        "/api/admin/users", headers=_auth(admin),
        json={"email": f"{name}@example.com", "username": name, "password": "a-long-enough-password-1", "role": "user", **extra},
    )
    assert r.status_code in (200, 201), r.text
    new = (await db.execute(select(User).where(User.username == name))).scalar_one()
    new.must_change_password = False
    await db.commit()
    return new.id, {"Authorization": _auth(new)["Authorization"]}


async def test_automations_are_off_until_an_admin_turns_them_on(db, user, client):
    uid, hdr = await _member(db, client, user)
    me = (await client.get("/api/auth/me", headers=hdr)).json()
    assert me["can_use_automations"] is False
    r = await client.get("/api/tasks", headers=hdr)
    assert r.status_code == 403
    assert "turned on" in r.json()["detail"]

    # Admins are never gated.
    assert (await client.get("/api/tasks", headers=_auth(user))).status_code == 200

    r = await client.patch(f"/api/admin/users/{uid}", headers=_auth(user), json={"can_use_automations": True})
    assert r.status_code == 200, r.text
    assert r.json()["can_use_automations"] is True
    assert (await client.get("/api/tasks", headers=hdr)).status_code == 200


async def test_admin_can_create_a_user_with_automations_on(db, user, client):
    _, hdr = await _member(db, client, user, can_use_automations=True)
    assert (await client.get("/api/tasks", headers=hdr)).status_code == 200


async def test_a_run_for_someone_without_automations_fails_and_the_clock_skips_them(db, user, client):
    from app.tasks.models import Task, TaskRun
    from app.tasks.runner import execute_run
    from app.tasks.scheduler import _claim_due

    uid, _ = await _member(db, client, user)
    from datetime import datetime, timedelta, timezone

    task = Task(user_id=uid, title="nightly", prompt="hi", frequency="daily", hour=1, minute=0,
                timezone="UTC", enabled=True, next_run_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    db.add(task)
    await db.flush()
    run = TaskRun(task_id=task.id, status="pending", trigger="manual")
    db.add(run)
    await db.commit()
    task_id, run_id = task.id, run.id

    await _claim_due()
    db.expire_all()
    scheduled = (await db.execute(
        select(TaskRun.id).where(TaskRun.task_id == task_id, TaskRun.trigger == "schedule")
    )).scalars().all()
    assert scheduled == []

    await execute_run(run_id)
    db.expire_all()
    done = await db.get(TaskRun, run_id)
    assert done.status == "failed"
    assert "turned off" in (done.error or "")


async def test_today_layout_saves_and_drops_unknown_cards(db, user, client):
    r = await client.patch(
        "/api/auth/me/preferences", headers=_auth(user),
        json={"today_hidden": ["photos", "nope", "Photos"], "today_order": ["rooms", "events", "bogus"]},
    )
    assert r.status_code == 200, r.text
    st = r.json()["settings"]
    assert st["today_hidden"] == ["photos"]
    assert st["today_order"] == ["rooms", "events"]

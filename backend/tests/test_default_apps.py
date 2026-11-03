"""Tasks & Reminders comes with every new account, and stays removable."""
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


async def _kinds(db, uid) -> set[str]:
    from app.items.models import ItemInstall

    db.expire_all()
    return set((await db.execute(select(ItemInstall.kind).where(ItemInstall.user_id == uid))).scalars())


async def test_new_account_starts_with_tasks_and_can_remove_it(db, user, client):
    from app.auth.models import User
    from app.auth.utils import create_access_token

    name = f"n{uuid.uuid4().hex[:6]}"
    r = await client.post(
        "/api/admin/users", headers=_auth(user),
        json={"email": f"{name}@example.com", "username": name, "password": "a-long-enough-password-1", "role": "user"},
    )
    assert r.status_code in (200, 201), r.text
    new = (await db.execute(select(User).where(User.username == name))).scalar_one()
    new.must_change_password = False  # admin-made accounts must change it first
    await db.commit()
    uid, tv = new.id, new.token_version
    assert "tasks" in await _kinds(db, uid)

    hdr = {"Authorization": f"Bearer {create_access_token(uid, token_version=tv)}"}
    lr = await client.get("/api/items/launcher", headers=hdr)
    assert lr.status_code == 200, lr.text
    launcher = lr.json()["apps"]
    assert any(a["kind"] == "tasks" for a in launcher)

    assert (await client.delete("/api/items/store/tasks", headers=hdr)).status_code in (200, 204)
    assert "tasks" not in await _kinds(db, uid)

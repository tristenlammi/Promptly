"""New members start with Places / Workspaces / Automations hidden; an admin
can lock a member to one model (groups can't widen it)."""
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
    return new, _auth(new)


async def test_new_members_start_with_the_big_apps_hidden(db, user, client):
    _, hdr = await _member(db, client, user)
    me = (await client.get("/api/auth/me", headers=hdr)).json()
    assert me["settings"]["hidden_nav"] == ["places", "workspaces", "tasks"]
    assert not me["settings"].get("features_chosen")

    # The first-sign-in prompt saves their pick and marks itself answered.
    r = await client.patch(
        "/api/auth/me/preferences", headers=hdr,
        json={"hidden_nav": ["places"], "features_chosen": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["hidden_nav"] == ["places"]
    assert r.json()["settings"]["features_chosen"] is True


async def test_a_locked_member_gets_only_their_one_model(db, user, client):
    from app.models_config.access import effective_allow_set

    member, hdr = await _member(db, client, user, allowed_models=["model-a"], model_locked=True)
    me = (await client.get("/api/auth/me", headers=hdr)).json()
    assert me["model_locked"] is True
    await db.refresh(member)
    assert await effective_allow_set(member, db) == {"model-a"}

    r = await client.patch(f"/api/admin/users/{member.id}", headers=_auth(user), json={"model_locked": False})
    assert r.status_code == 200, r.text
    assert r.json()["model_locked"] is False

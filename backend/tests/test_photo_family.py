"""The family library (PH-5): joining shares nothing; a member's share (all,
from a date, photos with certain people) puts their photos in for everyone
in the family — readable, in the family view and in search — and leaving,
or a smaller share, takes them out at once. Strangers see none of it."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401


async def _user(db, name):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:5]}", password_hash="x", role="user")
    db.add(u)
    await db.commit()
    return u


@pytest.mark.asyncio
async def test_family_library(client, db, user, root, fake_ml):
    from app.photos import family

    kid = await _user(db, "kid")
    stranger = await _user(db, "str")
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.commit()
    old = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=datetime(2019, 6, 1, tzinfo=timezone.utc), beach=True)
    new = await _scene(db, user, who=[sarah], lat=0.5, lon=0.5, when=datetime(2024, 6, 1, tzinfo=timezone.utc), beach=True)
    theirs = await _scene(db, kid, who=[], lat=0.5, lon=0.5, when=datetime(2024, 7, 1, tzinfo=timezone.utc))

    r = await client.post("/api/photos/family", json={"name": "The Lammis"}, headers=_auth(user))
    assert r.status_code == 201 and r.json()["family"]["owner"] is True
    r = await client.post("/api/photos/family/members", json={"user_id": str(kid.id)}, headers=_auth(user))
    assert [m["sharing"] for m in r.json()["family"]["members"]] == ["none", "none"]
    # Joined, nothing shared yet.
    fam = lambda who: client.get("/api/photos/timeline", params={"view": "family"}, headers=_auth(who))  # noqa: E731
    assert (await fam(kid)).json()["items"] == []
    assert (await client.get(f"/api/files/{new}/signed-urls", headers=_auth(kid))).status_code == 404

    # All of mine.
    r = await client.put("/api/photos/family/share", json={"mode": "all"}, headers=_auth(user))
    assert next(m for m in r.json()["family"]["members"] if m["you"])["photos"] == 2
    items = (await fam(kid)).json()["items"]
    assert {i["id"] for i in items} == {str(old), str(new)} and not any(i["mine"] for i in items)
    assert (await client.get(f"/api/files/{new}/signed-urls", headers=_auth(kid))).status_code == 200
    found = (await client.get("/api/photos/search", params={"q": "on the beach"}, headers=_auth(kid))).json()["items"]
    assert {i["id"] for i in found} >= {str(old), str(new)}
    # The kid's own photo isn't in until they share; they can't edit mine.
    assert str(theirs) not in {i["id"] for i in (await fam(user)).json()["items"]}
    assert (await client.put(f"/api/photos/files/{new}/edit", json={"rotate": 90}, headers=_auth(kid))).status_code == 404

    # From 2020 on: the old one goes.
    await client.put("/api/photos/family/share", json={"mode": "since", "since": "2020-01-01"}, headers=_auth(user))
    assert {i["id"] for i in (await fam(kid)).json()["items"]} == {str(new)}
    assert (await client.get(f"/api/files/{old}/signed-urls", headers=_auth(kid))).status_code == 404
    # Only photos with Sarah.
    r = await client.put("/api/photos/family/share", json={"mode": "people", "people": [str(sarah)]}, headers=_auth(user))
    assert r.json()["family"]["share"]["people"] == [{"id": str(sarah), "name": "Sarah"}]
    assert {i["id"] for i in (await fam(kid)).json()["items"]} == {str(new)}
    # Someone else's person can't be the rule.
    their_person = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'X') RETURNING id"), {"u": kid.id})
    await db.commit()
    assert (await client.put("/api/photos/family/share", json={"mode": "people", "people": [str(their_person)]}, headers=_auth(user))).status_code == 409

    # A new photo shared by the tick.
    await client.put("/api/photos/family/share", json={"mode": "all"}, headers=_auth(user))
    later = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=datetime(2025, 1, 1, tzinfo=timezone.utc))
    await db.execute(text("UPDATE photo_family_members SET checked_at = NULL"))
    await db.commit()
    await family.refresh_due(budget=10)
    assert str(later) in {i["id"] for i in (await fam(kid)).json()["items"]}

    # Strangers: nothing.
    assert (await client.get(f"/api/files/{new}/signed-urls", headers=_auth(stranger))).status_code == 404
    assert (await fam(stranger)).json()["items"] == []
    assert (await client.post("/api/photos/family/members", json={"user_id": str(stranger.id)}, headers=_auth(kid))).status_code == 409

    # The kid leaves: mine are out of their reach at once.
    await client.delete(f"/api/photos/family/members/{kid.id}", headers=_auth(kid))
    assert (await client.get(f"/api/files/{new}/signed-urls", headers=_auth(kid))).status_code == 404
    assert (await client.get("/api/photos/family", headers=_auth(kid))).json()["family"] is None
    # The owner leaving ends it.
    await client.delete(f"/api/photos/family/members/{user.id}", headers=_auth(user))
    assert await db.scalar(text("SELECT count(*) FROM photo_family_items")) == 0

"""Search covers albums shared with you (PH-4 follow-up): a member finds
the owner's photo in a shared album by what it shows or when — with whose
album it's from — but their own "Sarah" never matches someone else's
faces, a photo outside the album stays private, and smart albums keep to
the owner's own photos."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

T = datetime(2024, 3, 1, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_a_shared_album_is_searched_by_its_members(client, db, user, root, fake_ml):
    from app.auth.models import User

    pal = User(email=f"p-{uuid.uuid4().hex[:8]}@example.com", username=f"pal{uuid.uuid4().hex[:5]}", password_hash="x", role="user")
    db.add(pal)
    await db.commit()
    # Pal's beach photos: one in an album shared with the user, one not.
    shared = await _scene(db, pal, who=[], lat=0.5, lon=0.5, when=T, beach=True)
    private = await _scene(db, pal, who=[], lat=0.5, lon=0.5, when=T, beach=True)
    r = await client.post("/api/photos/albums", json={"title": "Trip", "file_ids": [str(shared)]}, headers=_auth(pal))
    album = r.json()["id"]
    await client.post(f"/api/photos/albums/{album}/members", json={"user_id": str(user.id), "role": "viewer"}, headers=_auth(pal))
    mine = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=T, beach=True)

    got = (await client.get("/api/photos/search", params={"q": "on the beach"}, headers=_auth(user))).json()
    ids = {i["id"] for i in got["items"]}
    assert ids == {str(mine), str(shared)}
    chip = next(c for i in got["items"] if i["id"] == str(shared) for c in i["chips"] if c["kind"] == "album")
    assert chip["label"] == f"{pal.username}'s “Trip”"

    # Their own Sarah only matches their own photos.
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.commit()
    assert (await client.get("/api/photos/search", params={"q": "Sarah"}, headers=_auth(user))).json()["items"] == []
    assert sarah

    # The chat card's refresh and the photo's own links work for a member.
    items = (await client.post("/api/photos/items", json={"ids": [str(shared), str(private)]}, headers=_auth(user))).json()["items"]
    assert [i["id"] for i in items] == [str(shared)]
    assert (await client.get(f"/api/files/{shared}/signed-urls", headers=_auth(user))).status_code == 200

    # A smart album is the owner's own photos only.
    r = await client.post("/api/photos/albums", json={"title": "Beach", "rules": {"looks_like": "on the beach"}}, headers=_auth(user))
    smart = (await client.get(f"/api/photos/albums/{r.json()['id']}/items", headers=_auth(user))).json()["items"]
    assert {i["id"] for i in smart} == {str(mine)}

    # Left the album: no longer searched.
    await client.delete(f"/api/photos/albums/{album}/members/{user.id}", headers=_auth(user))
    got = (await client.get("/api/photos/search", params={"q": "on the beach"}, headers=_auth(user))).json()
    assert {i["id"] for i in got["items"]} == {str(mine)}

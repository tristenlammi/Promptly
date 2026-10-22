"""Photos from only some folders: a person can limit Photos to their photos
folder(s) and what's inside them — the library, and the background work on
it (search, faces, text…), leave everything else alone. Hidden folders and
Chat Uploads aren't worked on either."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.test_photo_library_wp91 import _auth, _folder, _names, _photo, _utc, client  # noqa: F401


@pytest.mark.asyncio
async def test_photos_can_come_from_only_some_folders(client, db, user):
    from app.auth.models import User
    from app.photos.understanding import PLACE, pending

    other = User(email="o-folders@example.com", username="ofolders", password_hash="x", role="user")
    db.add(other)
    await db.commit()

    camera = await _folder(db, user, "Camera Uploads", system_kind="camera_uploads")
    month = await _folder(db, user, "2026-10", parent=camera)
    screens = await _folder(db, user, "Screenshots")
    chat = await _folder(db, user, "Chat Uploads", system_kind="chat_uploads")
    theirs = await _folder(db, other, "Theirs")
    await _photo(db, user, "beach.jpg", _utc(2026, 10, 1), folder=month)
    await _photo(db, user, "loose.jpg", _utc(2026, 10, 2))
    await _photo(db, user, "screen.png", _utc(2026, 10, 3), folder=screens, mime="image/png")
    await _photo(db, user, "pasted.jpg", _utc(2026, 10, 4), folder=chat)
    assert sorted(await _names(client, user)) == ["beach.jpg", "loose.jpg", "screen.png"]

    # The choices offered: your own top-level folders, Camera Uploads first,
    # never Chat Uploads.
    s = (await client.get("/api/photos/settings", headers=_auth(user))).json()
    assert s["only_folders"] == [] and s["folder_choices"][0]["name"] == "Camera Uploads"
    assert {c["name"] for c in s["folder_choices"]} == {"Camera Uploads", "Screenshots"}

    # Only Camera Uploads: its subfolders count; the rest leave Photos…
    r = await client.put("/api/photos/settings", json={"only_folders": [str(camera.id)]}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["only_folders"] == [{"id": str(camera.id), "name": "Camera Uploads"}]
    assert await _names(client, user) == ["beach.jpg"]
    # …and aren't worked on in the background (nor is Chat Uploads, ever).
    names = (await db.execute(
        text("SELECT filename FROM files WHERE id = ANY(:ids)"), {"ids": await pending(db, PLACE, 50)}
    )).scalars().all()
    assert names == ["beach.jpg"]

    # Someone else's folder can't be chosen; [] is everywhere again.
    r = await client.put("/api/photos/settings", json={"only_folders": [str(theirs.id)]}, headers=_auth(user))
    assert r.status_code == 404
    await client.put("/api/photos/settings", json={"only_folders": []}, headers=_auth(user))
    assert sorted(await _names(client, user)) == ["beach.jpg", "loose.jpg", "screen.png"]
    names = set((await db.execute(
        text("SELECT filename FROM files WHERE id = ANY(:ids)"), {"ids": await pending(db, PLACE, 50)}
    )).scalars().all())
    assert "pasted.jpg" not in names and {"beach.jpg", "loose.jpg", "screen.png"} <= names

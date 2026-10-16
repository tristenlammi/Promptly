"""Faces in photos (PH-2, WP-PH2.3): off until the owner turns them on;
then found in the background, shown in a photo's info to its owner; and
turning them off deletes every one at once."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _other_user, _unit, _webp
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401


@pytest.fixture
def fake_ml(monkeypatch):
    from app.photos import ml

    state = {"faces": "ready", "calls": 0}

    async def health(*, fresh=False):
        return {"state": "ready", "model": "fake-siglip@1", "faces": {"state": state["faces"], "model": "fake-faces@1"}}

    async def embed_images(images):
        return "fake-siglip@1", [_unit(0) for _ in images]

    async def find_faces(images):
        state["calls"] += 1
        # Two people in every picture.
        return "fake-faces@1", [
            [
                {"box": [0.1, 0.2, 0.2, 0.3], "landmarks": [[0.15, 0.3]] * 5, "score": 0.93, "size": 80, "embedding": _unit(1)[:512]},
                {"box": [0.6, 0.2, 0.2, 0.3], "landmarks": [[0.65, 0.3]] * 5, "score": 0.88, "size": 64, "embedding": _unit(2)[:512]},
            ]
            for _ in images
        ]

    async def faces_waiting():
        return None if state["faces"] == "ready" else "Getting the face models ready"

    async def not_here():
        return "not in this test"

    for name, fn in (("health", health), ("embed_images", embed_images), ("find_faces", find_faces),
                     ("faces_waiting", faces_waiting), ("animals_waiting", not_here), ("text_waiting", not_here)):
        monkeypatch.setattr(ml, name, fn)
    return state


@pytest.mark.asyncio
async def test_faces_only_once_turned_on_and_gone_when_turned_off(client, db, user, root, fake_ml):
    from app.photos.understanding import tick

    fid = await _photo(db, user, preview=_webp((200, 180, 160)))
    other = await _other_user(db)
    await _photo(db, other, preview=_webp((200, 180, 160)))  # hasn't turned faces on
    await tick(budget=10)
    assert fake_ml["calls"] == 0  # nobody asked for faces
    settings = (await client.get("/api/photos/settings", headers=_auth(user))).json()
    assert (settings["faces"], settings["face_count"]) == (False, 0)

    r = await client.put("/api/photos/settings", json={"faces": True}, headers=_auth(user))
    assert r.json()["faces"] is True
    await tick(budget=10)
    rows = (await db.execute(text("SELECT file_id, user_id, size_px FROM photo_faces ORDER BY box_x"))).all()
    assert [(r[0], r[1], r[2]) for r in rows] == [(fid, user.id, 80), (fid, user.id, 64)]  # only theirs
    prog = {s["stage"]: s for s in (await client.get("/api/photos/understanding", headers=_auth(user))).json()["stages"]}
    assert (prog["faces"]["done"], prog["faces"]["total"]) == (1, 1)
    media = (await client.get(f"/api/files/{fid}/media", headers=_auth(user))).json()
    assert [f["x"] for f in media["faces"]] == [0.1, 0.6]

    # Done again (a re-run): the same two faces, not four.
    await db.execute(text("DELETE FROM photo_understanding WHERE stage = 'faces'"))
    await db.commit()
    await tick(budget=10)
    assert await db.scalar(text("SELECT count(*) FROM photo_faces")) == 2

    # Off: every face is deleted at once, and nothing more is looked for.
    r = (await client.put("/api/photos/settings", json={"faces": False}, headers=_auth(user))).json()
    assert (r["faces"], r["face_count"]) == (False, 0)
    assert await db.scalar(text("SELECT count(*) FROM photo_faces")) == 0
    calls = fake_ml["calls"]
    await tick(budget=10)
    assert fake_ml["calls"] == calls
    assert (await client.get(f"/api/files/{fid}/media", headers=_auth(user))).json()["faces"] is None


@pytest.mark.asyncio
async def test_faces_wait_while_the_models_load(client, db, user, root, fake_ml):
    from app.photos.understanding import tick

    fake_ml["faces"] = "loading"
    await client.put("/api/photos/settings", json={"faces": True}, headers=_auth(user))
    fid = await _photo(db, user, preview=_webp((200, 180, 160)))
    await tick(budget=10)
    assert fake_ml["calls"] == 0
    prog = {s["stage"]: s for s in (await client.get("/api/photos/understanding", headers=_auth(user))).json()["stages"]}
    assert prog["faces"]["waiting"] == "Getting the face models ready"
    fake_ml["faces"] = "ready"
    await tick(budget=10)
    assert await db.scalar(text("SELECT count(*) FROM photo_faces WHERE file_id = :f"), {"f": fid}) == 2

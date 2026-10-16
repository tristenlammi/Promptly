"""Animals in photos (PH-2, WP-PH2.4): found for every library (no opt-in —
pets aren't biometric data), shown in a photo's info, replaced on a re-run."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _unit, _webp
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401


@pytest.fixture
def fake_ml(monkeypatch):
    from app.photos import ml

    state = {"calls": 0}

    async def health(*, fresh=False):
        return {"state": "ready", "model": "fake-siglip@1", "animals": {"state": "ready", "model": "fake-animals@1"}}

    async def embed_images(images):
        return "fake-siglip@1", [_unit(0) for _ in images]

    async def find_animals(images):
        state["calls"] += 1
        out = []
        for raw in images:
            from io import BytesIO

            from PIL import Image

            with Image.open(BytesIO(raw)) as im:
                r, g, b = im.convert("RGB").getpixel((0, 0))
            # A brownish picture has a dog in it; a grey one, nothing.
            out.append([{"species": "dog", "box": [0.2, 0.3, 0.4, 0.5], "score": 0.91, "size": 300,
                         "embedding": _unit(3), "embedding_dino": _unit(4)[:384]}] if r > b + 40 else [])
        return "fake-animals@1", out

    async def ready():
        return None

    async def off():
        return "off in this test"

    for name, fn in (("health", health), ("embed_images", embed_images), ("find_animals", find_animals),
                     ("animals_waiting", ready), ("faces_waiting", off), ("text_waiting", off)):
        monkeypatch.setattr(ml, name, fn)
    return state


@pytest.mark.asyncio
async def test_animals_are_found_and_shown(client, db, user, root, fake_ml):
    from app.photos.understanding import tick

    dog = await _photo(db, user, preview=_webp((160, 110, 60)))
    empty = await _photo(db, user, preview=_webp((120, 120, 120)))
    await tick(budget=10)
    rows = (await db.execute(text("SELECT file_id, species, size_px FROM photo_animals"))).all()
    assert [(r[0], r[1], r[2]) for r in rows] == [(dog, "dog", 300)]
    prog = {s["stage"]: s for s in (await client.get("/api/photos/understanding", headers=_auth(user))).json()["stages"]}
    assert (prog["animals"]["done"], prog["animals"]["total"]) == (2, 2)
    media = (await client.get(f"/api/files/{dog}/media", headers=_auth(user))).json()
    assert [a["species"] for a in media["animals"]] == ["dog"]
    assert (await client.get(f"/api/files/{empty}/media", headers=_auth(user))).json()["animals"] == []

    # A re-run replaces the machine's finds; one a person named stays.
    await db.execute(text("UPDATE photo_animals SET assigned_by = 'user'"))
    await db.execute(text("DELETE FROM photo_understanding WHERE stage = 'animals'"))
    await db.commit()
    await tick(budget=10)
    assert await db.scalar(text("SELECT count(*) FROM photo_animals")) == 2
    assert await db.scalar(text("SELECT count(*) FROM photo_animals WHERE assigned_by = 'user'")) == 1

"""Text in photos (PH-2, WP-PH2.5): read in the background, shown in a
photo's info, and found by search first — even while the photo models are
away, the words still find their photo."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _unit, _webp
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401


@pytest.fixture
def fake_ml(monkeypatch):
    from io import BytesIO

    from PIL import Image

    from app.photos import ml

    state = {"up": True}

    async def health(*, fresh=False):
        return {"state": "ready", "model": "fake-siglip@1", "text": {"state": "ready", "model": "fake-ocr@1"}} if state["up"] else None

    async def waiting():
        return None if state["up"] else "Photo search isn't set up (the photos-ml service isn't running)"

    async def embed_images(images):
        return "fake-siglip@1", [_unit(0) for _ in images]

    async def embed_texts(texts):
        return "fake-siglip@1", [_unit(1) for _ in texts]  # looks like nothing here

    async def find_text(images):
        out = []
        for raw in images:
            with Image.open(BytesIO(raw)) as im:
                r, g, b = im.convert("RGB").getpixel((0, 0))
            # A reddish picture is the warung's sign; others have no words.
            out.append({"text": "WARUNG MADE\nNasi Goreng 45.000", "lines": [{"text": "WARUNG MADE", "score": 0.99, "box": [0.1, 0.1, 0.5, 0.1]}]}
                       if r > b + 40 else {"text": "", "lines": []})
        return "fake-ocr@1", out

    async def ready():
        return None

    async def off():
        return "off in this test"

    for name, fn in (("health", health), ("waiting", waiting), ("embed_images", embed_images), ("embed_texts", embed_texts),
                     ("find_text", find_text), ("text_waiting", ready), ("animals_waiting", off), ("faces_waiting", off)):
        monkeypatch.setattr(ml, name, fn)
    return state


@pytest.mark.asyncio
async def test_text_in_photos_is_read_and_searched_first(client, db, user, root, fake_ml):
    from app.photos.understanding import tick

    sign = await _photo(db, user, preview=_webp((200, 60, 40)))
    plain = await _photo(db, user, preview=_webp((60, 60, 200)))
    await tick(budget=15)
    assert await db.scalar(text("SELECT text FROM photo_text WHERE file_id = :f"), {"f": sign}) == "WARUNG MADE\nNasi Goreng 45.000"
    assert await db.scalar(text("SELECT count(*) FROM photo_text WHERE file_id = :f"), {"f": plain}) == 0
    media = (await client.get(f"/api/files/{sign}/media", headers=_auth(user))).json()
    assert media["text"].startswith("WARUNG MADE")

    got = (await client.get("/api/photos/search", params={"q": "nasi goreng"}, headers=_auth(user))).json()
    assert [(i["id"], i["matched"]) for i in got["items"]] == [(str(sign), "text")]

    # The photo models away: the words still find it.
    fake_ml["up"] = False
    got = (await client.get("/api/photos/search", params={"q": "warung"}, headers=_auth(user))).json()
    assert [i["id"] for i in got["items"]] == [str(sign)]
    r = await client.get("/api/photos/search", params={"q": "sunset"}, headers=_auth(user))
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_a_tick_cut_off_mid_way_keeps_what_it_read(db, user, root, fake_ml, monkeypatch):
    """On a slow CPU the minute's tick was killed before its batch of 100
    finished, so nothing was ever saved and the same photos were read
    again every minute, forever. Now each small batch is saved as it ends."""
    import asyncio

    from app.photos import ml
    from app.photos.understanding import TEXT, tick

    ids = [await _photo(db, user, preview=_webp((220, 30, 30))) for _ in range(12)]
    real = ml.find_text
    calls = {"n": 0}

    async def slow_after_first(images):
        calls["n"] += 1
        if calls["n"] > 1:
            await asyncio.sleep(30)  # the second batch never finishes in time
        return await real(images)

    monkeypatch.setattr(ml, "find_text", slow_after_first)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(tick(budget=50), timeout=5)
    done = await db.scalar(text("SELECT count(*) FROM photo_understanding WHERE stage = 'text' AND state = 'done'"))
    assert done == TEXT.batch == 8 and len(ids) == 12


@pytest.mark.asyncio
async def test_only_one_understanding_tick_runs_at_a_time(monkeypatch):
    from app.photos import understanding
    from app.redis_client import redis
    from app.tasks import media_worker

    ran = []

    async def fake_tick():
        ran.append(1)
        return {}

    monkeypatch.setattr(understanding, "tick", fake_tick)
    await redis.set(media_worker._TICK_LOCK, "1", ex=60)  # one is still running
    try:
        assert (await media_worker.understand_tick({}))["skipped"] and ran == []
    finally:
        await redis.delete(media_worker._TICK_LOCK)
    await media_worker.understand_tick({})
    assert ran == [1] and not await redis.exists(media_worker._TICK_LOCK)

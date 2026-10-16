"""What's in a photo (PH-2, WP-PH2.2): the photos-ml service's vectors,
stored per photo, searched by text — only within your own library; and
nothing is failed while the service is away."""
from __future__ import annotations

import io
import uuid

import pytest
from sqlalchemy import select, text

from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401

DIM = 768


def _unit(i: int) -> list[float]:
    v = [0.0] * DIM
    v[i] = 1.0
    return v


def _webp(colour) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 24), colour).save(buf, "WEBP")
    return buf.getvalue()


@pytest.fixture
def fake_ml(monkeypatch):
    """A stand-in photos-ml: a reddish picture is "red" (axis 0), a bluish
    one "blue" (axis 1); text the same."""
    from app.photos import ml

    state = {"up": True, "model": "fake-siglip@1", "calls": 0}

    async def health(*, fresh=False):
        return {"state": "ready", "model": state["model"]} if state["up"] else None

    async def embed_images(images):
        from PIL import Image

        state["calls"] += 1
        out = []
        for raw in images:
            with Image.open(io.BytesIO(raw)) as im:
                r, g, b = im.convert("RGB").getpixel((0, 0))
            out.append(_unit(0) if r > b else _unit(1))
        return state["model"], out

    async def embed_texts(texts):
        return state["model"], [_unit(0) if "red" in t.lower() else _unit(1) for t in texts]

    monkeypatch.setattr(ml, "health", health)
    monkeypatch.setattr(ml, "embed_images", embed_images)
    monkeypatch.setattr(ml, "embed_texts", embed_texts)

    async def not_here():
        return "not in this test"

    monkeypatch.setattr(ml, "animals_waiting", not_here)
    monkeypatch.setattr(ml, "text_waiting", not_here)
    return state


async def _other_user(db):
    from app.auth.models import User

    row = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_photos_are_embedded_and_found_by_words(client, db, user, root, fake_ml):
    from app.photos.understanding import tick

    red = await _photo(db, user, preview=_webp((220, 30, 30)))
    blue = await _photo(db, user, preview=_webp((30, 30, 220)))
    theirs = await _photo(db, await _other_user(db), preview=_webp((230, 20, 20)))
    await tick(budget=20)
    n = await db.scalar(text("SELECT count(*) FROM photo_embeddings"))
    assert n == 3

    got = (await client.get("/api/photos/search", params={"q": "a red thing"}, headers=_auth(user))).json()
    ids = [i["id"] for i in got["items"]]
    assert ids == [str(red)]  # blue is nothing like it; someone else's red photo isn't yours
    assert str(theirs) not in ids and got["items"][0]["matched"] == "looks"
    got = (await client.get("/api/photos/search", params={"q": "blue"}, headers=_auth(user))).json()
    assert [i["id"] for i in got["items"]] == [str(blue)]

    # A new model (an upgrade): everything is embedded again, by it.
    fake_ml["model"] = "fake-siglip@2"
    calls = fake_ml["calls"]
    await tick(budget=20)
    assert fake_ml["calls"] > calls
    models = set((await db.execute(text("SELECT DISTINCT model FROM photo_embeddings"))).scalars())
    assert models == {"fake-siglip@2"}


@pytest.mark.asyncio
async def test_without_the_service_photos_wait_and_search_says_why(client, db, user, root, fake_ml):
    from app.photos.models import PhotoUnderstanding
    from app.photos.understanding import tick

    fake_ml["up"] = False
    fid = await _photo(db, user, preview=_webp((220, 30, 30)))
    await tick(budget=10)
    assert await db.get(PhotoUnderstanding, (fid, "embed")) is None  # waiting, not failed
    prog = (await client.get("/api/photos/understanding", headers=_auth(user))).json()
    embed = {s["stage"]: s for s in prog["stages"]}["embed"]
    assert embed["done"] == 0 and "isn't running" in embed["waiting"]
    r = await client.get("/api/photos/search", params={"q": "red"}, headers=_auth(user))
    assert r.status_code == 503 and "isn't running" in r.json()["detail"]

    fake_ml["up"] = True
    await tick(budget=10)
    assert (await db.get(PhotoUnderstanding, (fid, "embed"), populate_existing=True)).state == "done"
    rows = (await db.execute(select(PhotoUnderstanding).where(PhotoUnderstanding.stage == "embed"))).scalars().all()
    assert [r.input_key for r in rows] == ["fake-siglip@1"]

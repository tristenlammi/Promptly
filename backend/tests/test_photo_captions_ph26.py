"""Describing photos (PH-2, WP-PH2.6): only for people who turned it on;
searchable; a cloud model stops at the month's limit; off deletes them."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import text

from tests.test_photo_embeddings_ph22 import _webp
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401


def test_local_or_cloud():
    from app.photos.captions import is_local, parse

    p = lambda t, u: SimpleNamespace(type=t, base_url=u)  # noqa: E731
    assert is_local(p("ollama", "http://anything:11434"))
    assert is_local(p("openai_compatible", "http://192.168.1.20:8080/v1"))
    assert is_local(p("openai_compatible", "http://host.docker.internal:1234/v1"))
    assert not is_local(p("openai_compatible", "https://openrouter.ai/api/v1"))
    assert not is_local(p("anthropic", None))
    assert parse('Sure! {"caption": "A dog on a beach at sunset.", "tags": ["Dog", "beach"]}') == (
        "A dog on a beach at sunset.", ["dog", "beach"])
    assert parse("Just a red square.") == ("Just a red square.", [])


@pytest.fixture
def fake_vision(monkeypatch):
    from app.photos import captions, ml

    state = {"local": False, "limit": 10, "calls": 0}

    async def configured(db):
        return captions.Vision(SimpleNamespace(name="Cloudy"), "cloudy-vision-1", state["local"], "cloudy-vision-1 (Cloudy)", state["limit"])

    async def describe(vision, preview, db):
        state["calls"] += 1
        return "A golden retriever running on a sandy beach.", ["dog", "beach", "sand"]

    async def off():
        return "off in this test"

    monkeypatch.setattr(captions, "configured", configured)
    monkeypatch.setattr(captions, "describe", describe)
    for name in ("waiting", "faces_waiting", "animals_waiting", "text_waiting"):
        monkeypatch.setattr(ml, name, off)
    return state


@pytest.mark.asyncio
async def test_photos_are_described_for_those_who_asked(client, db, user, root, fake_vision):
    from app.photos.understanding import tick

    a = await _photo(db, user, preview=_webp((200, 150, 90)))
    b = await _photo(db, user, preview=_webp((190, 140, 80)))
    # Another day: not a burst of the same moment (which would show as one).
    await db.execute(text("UPDATE photo_assets SET taken_at = taken_at - interval '1 day' WHERE file_id = :f"), {"f": b})
    await db.commit()
    await tick(budget=10)
    assert fake_vision["calls"] == 0  # off until asked
    s = (await client.get("/api/photos/settings", headers=_auth(user))).json()
    assert s["captions"] is False and s["captions_model"] == {"label": "cloudy-vision-1 (Cloudy)", "local": False}

    fake_vision["limit"] = 1  # a cloud model, one photo a month
    await client.put("/api/photos/settings", json={"captions": True}, headers=_auth(user))
    await tick(budget=10)
    assert await db.scalar(text("SELECT count(*) FROM photo_captions")) == 1
    prog = {x["stage"]: x for x in (await client.get("/api/photos/understanding", headers=_auth(user))).json()["stages"]}
    assert prog["captions"]["done"] == 1 and "limit" in prog["captions"]["waiting"]

    fake_vision["local"] = True  # on this server: no limit
    await tick(budget=10)
    assert await db.scalar(text("SELECT count(*) FROM photo_captions")) == 2

    got = (await client.get("/api/photos/search", params={"q": "retrievers on beaches"}, headers=_auth(user))).json()
    assert {i["id"] for i in got["items"]} == {str(a), str(b)} and {i["matched"] for i in got["items"]} == {"description"}
    media = (await client.get(f"/api/files/{a}/media", headers=_auth(user))).json()
    assert media["caption"] == {"text": "A golden retriever running on a sandy beach.", "tags": ["dog", "beach", "sand"]}

    # Off: the descriptions go too.
    s = (await client.put("/api/photos/settings", json={"captions": False}, headers=_auth(user))).json()
    assert s["captions"] is False and s["faces"] is False
    assert await db.scalar(text("SELECT count(*) FROM photo_captions")) == 0

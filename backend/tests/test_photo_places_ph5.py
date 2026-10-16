"""Places (PH-5): where your photos were taken — countries, then towns,
then the photos taken there."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tests.test_photo_engine_ph4 import _gazetteer, _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

T = datetime(2024, 3, 1, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_countries_towns_and_their_photos(client, db, user, root, fake_ml):
    from app.photos import places

    _gazetteer(places.local_dir())
    await places.load(db)
    noosa = [await _scene(db, user, who=[], lat=-26.394, lon=153.091, when=T) for _ in range(2)]
    await _scene(db, user, who=[], lat=-27.47, lon=153.03, when=T)
    madrid = await _scene(db, user, who=[], lat=40.42, lon=-3.70, when=T)

    got = (await client.get("/api/photos/places", headers=_auth(user))).json()
    assert [(c["code"], c["name"], c["count"]) for c in got["countries"]] == [("AU", "Australia", 3), ("ES", "Spain", 1)]
    assert got["countries"][1]["cover"]["id"] == str(madrid)

    au = (await client.get("/api/photos/places", params={"country": "AU"}, headers=_auth(user))).json()
    assert au["country"] == {"code": "AU", "name": "Australia"}
    assert [(p["name"], p["admin1"], p["count"]) for p in au["places"]] == [("Noosa Heads", "Queensland", 2), ("Brisbane", "Queensland", 1)]

    there = (await client.get("/api/photos/timeline", params={"place": au["places"][0]["id"]}, headers=_auth(user))).json()
    assert {i["id"] for i in there["items"]} == {str(f) for f in noosa}
    spain = (await client.get("/api/photos/timeline", params={"country": "ES"}, headers=_auth(user))).json()
    assert [i["id"] for i in spain["items"]] == [str(madrid)]

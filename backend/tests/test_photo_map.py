"""The Photos map (PH-5): every located photo of yours as compact arrays —
not a hidden location, not someone else's — and the optional offline
basemap, read in byte ranges, for signed-in people only."""
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
async def test_map_points_and_basemap(client, db, user, root, fake_ml, monkeypatch, tmp_path):
    from app.auth.models import User

    here = await _scene(db, user, who=[], lat=-26.39, lon=153.09, when=T)
    hidden = await _scene(db, user, who=[], lat=40.4, lon=-3.7, when=T)
    await db.execute(text("UPDATE file_media SET location_hidden = true WHERE file_id = :f"), {"f": hidden})
    moved = await _scene(db, user, who=[], lat=1.0, lon=1.0, when=T)
    await db.execute(text("UPDATE file_media SET lat_override = 51.5, lon_override = -0.12 WHERE file_id = :f"), {"f": moved})
    await db.commit()
    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    await _scene(db, other, who=[], lat=10.0, lon=10.0, when=T)

    got = (await client.get("/api/photos/map", headers=_auth(user))).json()
    pts = {i: (la, lo) for i, la, lo in zip(got["ids"], got["lat"], got["lon"])}
    assert pts == {str(here): (-26.39, 153.09), str(moved): (51.5, -0.12)}
    assert got["basemap"] is None
    assert (await client.get("/api/photos/basemap.pmtiles", headers=_auth(user))).status_code == 404

    tiles = tmp_path / "basemap.pmtiles"
    tiles.write_bytes(b"PMTiles" + bytes(range(256)) * 10)
    monkeypatch.setenv("MAP_PMTILES", str(tiles))
    assert (await client.get("/api/photos/map", headers=_auth(user))).json()["basemap"] == "/api/photos/basemap.pmtiles"
    r = await client.get("/api/photos/basemap.pmtiles", headers={**_auth(user), "Range": "bytes=0-6"})
    assert r.status_code == 206 and r.content == b"PMTiles"
    assert (await client.get("/api/photos/basemap.pmtiles")).status_code == 401

"""Photos at scale (PH-7): the library's heavier reads on 50,000 photos —
opt-in (``PROMPTLY_PERF=1``), as it takes a while to seed. Prints each
timing and fails past a generous budget, so a slow path shows up."""
from __future__ import annotations

import os
import time
from datetime import date

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _gazetteer, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

N = int(os.environ.get("PROMPTLY_PERF_N", "50000"))
pytestmark = pytest.mark.skipif(not os.environ.get("PROMPTLY_PERF"), reason="set PROMPTLY_PERF=1 to run")


async def _seed(db, user) -> None:
    """N photos over ten years: most at home (Brisbane), trips to Madrid,
    bursts, a few screenshots and big videos."""
    places = (await db.execute(text("SELECT geonameid, lat, lon FROM geo_places ORDER BY geonameid"))).all()
    from tests.test_understanding_ph21 import _photos_folder

    photos = await _photos_folder(db, user)  # the library is the Photos folder
    home = next(p for p in places if p.geonameid == 2174003)
    away = next(p for p in places if p.geonameid == 3117735)
    await db.execute(
        text(
            """
            WITH g AS (
              SELECT i, gen_random_uuid() AS id,
                     timestamptz '2016-01-01' + (i * interval '1 hour' * (87600.0 / CAST(:n AS int))) AS t,
                     (i % 50 = 0) AS shot, (i % 997 = 0) AS vid, ((i / 40) % 25 = 0) AS trip
              FROM generate_series(1, CAST(:n AS int)) i
            ), f AS (
              INSERT INTO files (id, user_id, folder_id, filename, original_filename, mime_type, size_bytes, storage_path)
              SELECT id, CAST(:u AS uuid), CAST(:pf AS uuid), CASE WHEN shot THEN 'Screenshot ' || i || '.png' ELSE 'IMG_' || i || '.jpg' END, 'x',
                     CASE WHEN vid THEN 'video/mp4' WHEN shot THEN 'image/png' ELSE 'image/jpeg' END,
                     CASE WHEN vid THEN 200000000 ELSE 2500000 + (i % 1000) END, 'u/' || id
              FROM g RETURNING id
            ), m AS (
              INSERT INTO file_media (file_id, kind, taken_at, lat, lon, width, height, make, extracted_at, derivative_state, renditions)
              SELECT id, CASE WHEN vid THEN 'video' ELSE 'image' END, t,
                     CASE WHEN trip THEN CAST(:alat AS float8) ELSE CAST(:hlat AS float8) END + (random() - 0.5) * 0.05,
                     CASE WHEN trip THEN CAST(:alon AS float8) ELSE CAST(:hlon AS float8) END + (random() - 0.5) * 0.05,
                     4032, 3024, CASE WHEN shot THEN NULL ELSE 'Pixel' END, now(), 'ready',
                     '{"thumb.webp": {"width": 320, "height": 240, "bytes": 9000}}'::jsonb
              FROM g RETURNING file_id
            )
            INSERT INTO photo_assets (file_id, user_id, kind, taken_at, taken_local, place_id, phash, sharpness, quality)
            SELECT id, CAST(:u AS uuid), CASE WHEN vid THEN 'video' ELSE 'image' END, t, t AT TIME ZONE 'UTC',
                   CASE WHEN trip THEN CAST(:ap AS int) ELSE CAST(:hp AS int) END,
                   -- a burst every 20 photos: the same hash, a bit or two apart
                   CASE WHEN i % 20 < 3 THEN (hashtext((i / 20)::text)::bigint << 20) # (i % 20)
                        ELSE (hashtext(i::text)::bigint << 32) # hashtext((i * 7)::text)::bigint END,
                   CASE WHEN i % 33 = 0 THEN 0.1 ELSE 0.8 END, random()
            FROM g
            """
        ),
        {"n": N, "u": user.id, "pf": photos.id, "hlat": home.lat, "hlon": home.lon, "alat": away.lat, "alon": away.lon,
         "hp": home.geonameid, "ap": away.geonameid},
    )
    await db.commit()
    for table in ("files", "file_media", "photo_assets"):
        await db.execute(text(f"ANALYZE {table}"))


@pytest.mark.asyncio
async def test_photos_at_scale(client, db, user, root, fake_ml):
    from app.photos import cleanup, memories, places

    _gazetteer(places.local_dir())
    await places.load(db)
    t = time.monotonic()
    await _seed(db, user)
    print(f"\nseeded {N} photos in {time.monotonic() - t:.1f}s")

    timings: dict[str, float] = {}

    async def timed(name, coro):
        t0 = time.monotonic()
        out = await coro
        timings[name] = time.monotonic() - t0
        print(f"{name:28s} {timings[name] * 1000:8.0f} ms")
        return out

    h = _auth(user)
    await timed("buckets", client.get("/api/photos/buckets", headers=h))
    await timed("timeline page", client.get("/api/photos/timeline", params={"limit": 150}, headers=h))
    await timed("timeline deep month", client.get("/api/photos/timeline", params={"month": "2018-06", "limit": 150}, headers=h))
    await timed("places", client.get("/api/photos/places", headers=h))
    await timed("places in a country", client.get("/api/photos/places", params={"country": "AU"}, headers=h))
    await timed("timeline at a place", client.get("/api/photos/timeline", params={"place": 3117735}, headers=h))
    found = await timed("cleanup.find", cleanup.find(db, user))
    r = await timed("cleanup endpoint", client.get("/api/photos/cleanup", headers=h))
    assert r.status_code == 200
    made = await timed("memories.generate", memories.generate(db, user, date(2026, 10, 15)))
    await db.commit()
    await timed("search (words + filters)", client.get("/api/photos/search", params={"q": "videos in Madrid"}, headers=h))
    print(f"duplicates {found['duplicate']['count']}, blurry {found['blurry']['count']}, "
          f"screenshots {found['screenshot']['count']}, big videos {found['large_video']['count']}, memories {made}")

    budget = {"buckets": 2, "timeline page": 1, "timeline deep month": 1, "places": 2, "places in a country": 2,
              "timeline at a place": 1, "cleanup.find": 15, "cleanup endpoint": 20, "memories.generate": 20,
              "search (words + filters)": 5}
    slow = {k: round(v, 2) for k, v in timings.items() if v > budget[k] * N / 50000}
    assert not slow, slow

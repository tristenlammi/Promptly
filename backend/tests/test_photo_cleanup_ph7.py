"""Cleanup (PH-7): duplicates (same bytes, a copy, a burst) grouped with
the best one kept; blurry shots, screenshots and large videos suggested;
"Keep" isn't suggested again; a favourite is never called blurry."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401

T = datetime(2024, 3, 1, 9, tzinfo=timezone.utc)
BASE = 0x1234_5678_9ABC_DEF0


async def _set(db, fid, *, phash=None, sharp=0.8, quality=0.6, when=T, size=1000, sha=None, mime="image/jpeg", name=None, star=False):
    await db.execute(
        text("UPDATE photo_assets SET phash = :p, sharpness = :s, quality = :q, taken_at = :t WHERE file_id = :f"),
        {"p": phash, "s": sharp, "q": quality, "t": when, "f": fid},
    )
    await db.execute(
        text("UPDATE files SET size_bytes = :z, content_sha256 = :h, mime_type = :m, filename = COALESCE(:n, filename), "
             "starred_at = CASE WHEN :star THEN now() END WHERE id = :f"),
        {"z": size, "h": sha, "m": mime, "n": name, "star": star, "f": fid},
    )
    await db.commit()


@pytest.mark.asyncio
async def test_cleanup_suggestions(client, db, user, root):
    ids = [await _photo(db, user) for _ in range(10)]
    a, a_copy, b1, b2, far, blurry, fav_blurry, shot, same_bytes, plain = ids
    await _set(db, a, phash=BASE, quality=0.9, sha="x" * 64)
    await _set(db, same_bytes, phash=BASE ^ 0xFF00, quality=0.2, sha="x" * 64, when=T + timedelta(days=30))  # same bytes
    await _set(db, a_copy, phash=BASE ^ 0b101, quality=0.5, when=T + timedelta(days=200))  # a resave, months later
    await _set(db, b1, phash=0x0F0F_0F0F_0F0F_0F0F, quality=0.4, when=T + timedelta(days=1))
    await _set(db, b2, phash=0x0F0F_0F0F_0F0F_0F0F ^ 0b11111, quality=0.7, when=T + timedelta(days=1, minutes=2))  # a burst
    await _set(db, far, phash=0x0F0F_0F0F_0F0F_0F0F ^ 0b1111100000, when=T + timedelta(days=90))  # alike (5 bits), other day: not a copy
    await _set(db, blurry, phash=0x7777_0000_7777_0000, sharp=0.1)
    await _set(db, fav_blurry, phash=0x7070_0707_7070_0707, sharp=0.1, star=True)
    await _set(db, shot, phash=0x1111_2222_3333_4444, mime="image/png", name="Screenshot 2024-03-01.png")
    await _set(db, plain, phash=0x5555_AAAA_5555_AAAA)
    await db.execute(text("UPDATE file_media SET make = 'Pixel' WHERE file_id = ANY(:ids)"), {"ids": [i for i in ids if i != shot]})
    vid = await _photo(db, user, kind="video")
    await _set(db, vid, size=300 * 1024 * 1024)

    got = (await client.get("/api/photos/cleanup", headers=_auth(user))).json()
    groups = {g["keep"]["id"]: {o["id"] for o in g["others"]} for g in got["duplicate"]["groups"]}
    assert groups == {str(a): {str(a_copy), str(same_bytes)}, str(b2): {str(b1)}}
    assert got["duplicate"]["count"] == 3 and got["duplicate"]["bytes"] == 3000
    assert [i["id"] for i in got["blurry"]["items"]] == [str(blurry)]
    assert [i["id"] for i in got["screenshot"]["items"]] == [str(shot)]
    assert [i["id"] for i in got["large_video"]["items"]] == [str(vid)] and got["large_video"]["items"][0]["size"] == 300 * 1024 * 1024

    # "Keep" the burst's other shot and the screenshot: not suggested again.
    r = await client.post("/api/photos/cleanup/keep", json={"file_ids": [str(b1)], "reason": "duplicate"}, headers=_auth(user))
    assert r.json() == {"kept": 1}
    await client.post("/api/photos/cleanup/keep", json={"file_ids": [str(shot)], "reason": "screenshot"}, headers=_auth(user))
    got = (await client.get("/api/photos/cleanup", headers=_auth(user))).json()
    assert [g["keep"]["id"] for g in got["duplicate"]["groups"]] == [str(a)]
    assert got["screenshot"]["count"] == 0

    # Moved to the trash: gone from the suggestions.
    await db.execute(text("UPDATE files SET trashed_at = now() WHERE id = :f"), {"f": a_copy})
    await db.commit()
    got = (await client.get("/api/photos/cleanup", headers=_auth(user))).json()
    assert {o["id"] for g in got["duplicate"]["groups"] for o in g["others"]} == {str(same_bytes)}

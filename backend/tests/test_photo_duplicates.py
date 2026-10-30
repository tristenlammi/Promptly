"""A photo you already have, arriving again (a phone synced after a Google
Takeout), is hidden as a copy — the same file, or the same moment and the
same picture — never a different photo taken at the same time; "not a copy"
brings it back for good."""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import text

from tests.test_photo_library_wp91 import _auth, _names, _photo, _utc, client  # noqa: F401


async def _set(db, fid, *, phash=None, sha=None, minutes_later=0):
    from app.files.models import UserFile
    from app.photos.models import PhotoAsset

    a = await db.get(PhotoAsset, fid)
    a.phash = phash
    f = await db.get(UserFile, fid)
    if sha:
        f.content_sha256 = sha
    f.created_at = f.created_at + timedelta(minutes=minutes_later)
    await db.commit()
    return a


@pytest.mark.asyncio
async def test_the_phones_copy_of_a_takeout_photo_is_hidden(client, db, user):
    from app.photos.duplicates import hide_if_copy

    when = _utc(2024, 3, 9, 10, 15, 30)
    takeout = await _photo(db, user, "PXL_20240309_101530.jpg", when)
    await _set(db, takeout, phash=0x0F0F_0F0F_0F0F_0F0F, sha="a" * 64)
    # The phone's original: other bytes, the same moment, the same picture.
    phone = await _photo(db, user, "PXL_20240309_101530 (1).jpg", when)
    a = await _set(db, phone, phash=0x0F0F_0F0F_0F0F_0F0D, sha="b" * 64, minutes_later=5)
    assert await hide_if_copy(db, a) is True
    await db.commit()
    assert await _names(client, user) == ["PXL_20240309_101530.jpg"]

    got = (await client.get("/api/photos/copies", headers=_auth(user))).json()
    assert got["count"] == 1 and got["items"][0]["copy"]["id"] == str(phone)
    assert got["items"][0]["original"]["id"] == str(takeout)

    # "Not a copy": back, and not hidden again.
    r = await client.post("/api/photos/copies/not", json={"file_ids": [str(phone)]}, headers=_auth(user))
    assert r.json()["restored"] == 1
    assert sorted(await _names(client, user)) == ["PXL_20240309_101530 (1).jpg", "PXL_20240309_101530.jpg"]
    from app.photos.models import PhotoAsset

    assert await hide_if_copy(db, await db.get(PhotoAsset, phone, populate_existing=True)) is False


@pytest.mark.asyncio
async def test_the_same_file_again_is_a_copy_even_a_video(db, user):
    from app.photos.duplicates import hide_if_copy

    first = await _photo(db, user, "clip.mp4", _utc(2024, 1, 1), kind="video")
    await _set(db, first, sha="c" * 64)
    again = await _photo(db, user, "clip (1).mp4", _utc(2024, 1, 1), kind="video")
    a = await _set(db, again, sha="c" * 64, minutes_later=1)
    assert await hide_if_copy(db, a) is True
    assert a.duplicate_of == first


@pytest.mark.asyncio
async def test_a_different_photo_at_the_same_moment_isnt_a_copy(db, user):
    from app.photos.duplicates import hide_if_copy

    when = _utc(2024, 5, 5, 12, 0, 0)
    mine = await _photo(db, user, "a.jpg", when)
    await _set(db, mine, phash=0x0000_0000_FFFF_FFFF)
    # Taken the same second, but another picture (someone else's camera).
    other = await _photo(db, user, "b.jpg", when)
    a = await _set(db, other, phash=0x7A3C_1E0F_00FF_0F0F, minutes_later=1)
    assert await hide_if_copy(db, a) is False
    # The same picture, but a minute apart: two shots, not a copy.
    later = await _photo(db, user, "c.jpg", when + timedelta(minutes=1))
    a = await _set(db, later, phash=0x0000_0000_FFFF_FFFF, minutes_later=2)
    assert await hide_if_copy(db, a) is False
    assert uuid.UUID(str(mine))  # the original is untouched
    assert await db.scalar(text("SELECT count(*) FROM photo_assets WHERE duplicate_of IS NOT NULL")) == 0


@pytest.mark.asyncio
async def test_a_burst_from_the_phone_isnt_hidden_as_copies(db, user):
    """A Pixel shoots several frames a second and stamps each to the
    millisecond: nearly the same picture, the same second — but each frame
    its own photo, never hidden as a copy of the one before."""
    from app.photos.duplicates import hide_if_copy

    when = _utc(2024, 6, 1, 18, 0, 5)
    first = await _photo(db, user, "PXL_20240601_180005100.jpg", when.replace(microsecond=100_000))
    await _set(db, first, phash=0x0F0F_0F0F_0F0F_0F0F)
    second = await _photo(db, user, "PXL_20240601_180005400.jpg", when.replace(microsecond=400_000))
    a = await _set(db, second, phash=0x0F0F_0F0F_0F0F_0F0D, minutes_later=1)
    assert await hide_if_copy(db, a) is False

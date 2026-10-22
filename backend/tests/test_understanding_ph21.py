"""Understanding photos, part one (PH-2, WP-PH2.1): where each was taken,
from an offline gazetteer; how good it is; per-photo progress per stage."""
from __future__ import annotations

import io
import uuid
import zipfile
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401

@pytest.fixture(autouse=True)
async def _gazetteer_keys(db):  # after db: its loop, a fresh redis pool
    """No load lock or remembered failure left by another run."""
    from app.redis_client import redis

    for key in ("promptly:gazetteer:failed", "promptly:gazetteer:loading"):
        await redis.delete(key)
    yield


_ROWS = [
    # geonameid, name, ascii, alternates, lat, lon, class, code, cc, cc2, admin1, …, population, …, tz
    (2152286, "Noosa Heads", -26.3941, 153.0909, "PPL", "AU", "04", 4000),
    (2148928, "Sunshine Beach", -26.4064, 153.1027, "PPL", "AU", "04", 2400),
    (2174003, "Brisbane", -27.4679, 153.0281, "PPLA", "AU", "04", 2_000_000),
    (2150000, "Old Noosa", -26.3942, 153.0910, "PPLQ", "AU", "04", 0),  # abandoned: never a photo's place
    (3117735, "Madrid", 40.4165, -3.7026, "PPLC", "ES", "29", 3_255_944),
]


def _gazetteer(dir_):
    dir_.mkdir(parents=True, exist_ok=True)
    lines = []
    for gid, name, lat, lon, _cls, code, cc, a1, *rest in [(*r[:4], "P", *r[4:]) for r in _ROWS]:
        pop = rest[0]
        lines.append("\t".join([
            str(gid), name, name, "", str(lat), str(lon), "P", code, cc, "", a1, "", "", "", str(pop), "", "10",
            "Australia/Brisbane" if cc == "AU" else "Europe/Madrid", "2024-01-01",
        ]))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("cities500.txt", "\n".join(lines) + "\n")
    (dir_ / "cities500.zip").write_bytes(buf.getvalue())
    (dir_ / "admin1CodesASCII.txt").write_text("AU.04\tQueensland\tQueensland\t2152274\nES.29\tMadrid\tMadrid\t3117732\n", "utf-8")
    (dir_ / "countryInfo.txt").write_text(
        "# GeoNames country info\n#ISO\tISO3\tISO-Numeric\tfips\tCountry\tCapital\n"
        "AU\tAUS\t036\tAS\tAustralia\tCanberra\t7686850\t24992369\tOC\n"
        "ES\tESP\t724\tSP\tSpain\tMadrid\t504782\t46723749\tEU\n", "utf-8",
    )


@pytest.mark.asyncio
async def test_the_nearest_place_offline(db, root):
    from app.photos import places

    _gazetteer(places.local_dir())
    assert await places.load(db) == 4  # the abandoned one is left out
    noosa = await places.nearest(db, -26.395, 153.091)
    assert (await places.describe(db, noosa)).label == "Noosa Heads, Queensland, Australia"
    assert (await places.describe(db, await places.nearest(db, -26.407, 153.103))).name == "Sunshine Beach"
    # Out in the bush, 60 km from anywhere listed: still the nearest town.
    assert (await places.describe(db, await places.nearest(db, -27.0, 152.5))).name in ("Brisbane", "Noosa Heads")
    assert await places.nearest(db, -30.0, 170.0) is None  # the open sea
    assert (await places.describe(db, await places.nearest(db, 40.42, -3.70))).label == "Madrid, Spain"


def _image(kind: str, size=(640, 480)) -> bytes:
    import numpy as np
    from PIL import Image, ImageFilter

    rng = np.random.default_rng(7)
    if kind == "black":
        im = Image.new("RGB", size, (0, 0, 0))
    else:
        base = (rng.random((size[1] // 16, size[0] // 16, 3)) * 255).astype("uint8")
        im = Image.fromarray(base).resize(size, Image.Resampling.NEAREST)  # crisp edges
        if kind == "blurry":
            im = im.filter(ImageFilter.GaussianBlur(12))
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=90)
    return buf.getvalue()


def test_quality_and_near_duplicates(tmp_path):
    from PIL import Image

    from app.photos.quality import hamming, measure

    paths = {}
    for kind in ("sharp", "blurry", "black"):
        paths[kind] = tmp_path / f"{kind}.webp"
        paths[kind].write_bytes(_image(kind))
    smaller = tmp_path / "smaller.webp"
    with Image.open(paths["sharp"]) as im:
        im.resize((320, 240)).save(smaller, "WEBP", quality=60)
    sharp, blurry, black = (measure(paths[k]) for k in ("sharp", "blurry", "black"))
    small = measure(smaller)
    assert sharp.sharpness > blurry.sharpness + 0.2
    assert sharp.quality > blurry.quality and black.quality < 0.3 and black.brightness < 0.05
    assert hamming(sharp.phash, small.phash) <= 6  # the same picture, resized and resaved
    assert hamming(sharp.phash, black.phash) > 16


async def _photos_folder(db, user):
    """The user's Photos folder — the library (made if it isn't there)."""
    from app.files.system_folders import ensure_camera_uploads

    folder = await ensure_camera_uploads(db, user)
    await db.commit()
    return folder


async def _photo(db, user, *, lat=None, lon=None, preview: bytes | None = None, kind="image"):
    from app.files.derivatives import rendition_path
    from app.files.models import FileMedia, UserFile
    from app.photos.library import sync

    fid = uuid.uuid4()
    folder = await _photos_folder(db, user)
    db.add(UserFile(id=fid, user_id=user.id, folder_id=folder.id, filename=f"{fid}.jpg", original_filename="x.jpg",
                    mime_type="image/jpeg", size_bytes=1, storage_path=f"u/{fid}"))
    await db.flush()
    now = datetime.now(timezone.utc)
    db.add(FileMedia(file_id=fid, kind=kind, taken_at=now, lat=lat, lon=lon, extracted_at=now,
                     derivative_state="ready" if preview else "pending"))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    if preview:
        path = rendition_path(fid, "preview.webp")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(preview)
    return fid


@pytest.mark.asyncio
async def test_photos_are_placed_and_measured_and_progress_shows(client, db, user, root):
    from app.files.models import FileMedia
    from app.photos import places
    from app.photos.library import sync
    from app.photos.models import PhotoAsset, PhotoUnderstanding
    from app.photos.understanding import tick

    _gazetteer(places.local_dir())
    beach = await _photo(db, user, lat=-26.395, lon=153.091, preview=_image("sharp"))
    indoors = await _photo(db, user, preview=_image("blurry"))  # no location
    waiting = await _photo(db, user)  # its preview isn't made yet

    before = (await client.get("/api/photos/understanding", headers=_auth(user))).json()
    assert before["complete"] is False
    await tick(budget=20)  # loads the place names on the way (from the local files)

    a = await db.get(PhotoAsset, beach, populate_existing=True)
    assert (await places.describe(db, a.place_id)).name == "Noosa Heads"
    assert a.quality is not None and a.phash is not None and a.sharpness > 0.5
    b = await db.get(PhotoAsset, indoors, populate_existing=True)
    assert b.place_id is None and b.sharpness < a.sharpness
    states = {(r.file_id, r.stage): r.state for r in (await db.execute(select(PhotoUnderstanding))).scalars()}
    assert states[(beach, "place")] == "done" and states[(indoors, "place")] == "skipped"
    assert (waiting, "quality") not in states  # waits for its preview

    got = (await client.get("/api/photos/understanding", headers=_auth(user))).json()
    by = {s["stage"]: s for s in got["stages"]}
    assert (by["place"]["done"], by["place"]["total"]) == (3, 3)
    assert (by["quality"]["done"], by["quality"]["total"]) == (2, 3)

    # The photo's info names the place, credited.
    media = (await client.get(f"/api/files/{beach}/media", headers=_auth(user))).json()
    assert media["place"]["label"] == "Noosa Heads, Queensland, Australia"
    assert "GeoNames" in media["place"]["attribution"]

    # Moved (an edit): it's placed again on the next tick.
    m = await db.get(FileMedia, beach)
    m.lat_override, m.lon_override = 40.42, -3.70
    await sync(db, beach)
    await db.commit()
    assert await db.get(PhotoUnderstanding, (beach, "place"), populate_existing=True) is None
    await tick(budget=10)
    a = await db.get(PhotoAsset, beach, populate_existing=True)
    assert (await places.describe(db, a.place_id)).name == "Madrid"


@pytest.mark.asyncio
async def test_without_place_names_photos_wait_and_the_admin_is_told(client, db, user, root, monkeypatch):
    from app.photos import places
    from app.photos.understanding import tick

    await db.execute(__import__("sqlalchemy").text("TRUNCATE geo_places, geo_admin1, geo_countries"))
    await db.commit()
    monkeypatch.setenv("GEONAMES_URL", "http://127.0.0.1:9/")  # nothing listens there
    fid = await _photo(db, user, lat=-26.395, lon=153.091)
    await tick(budget=10)
    from app.photos.models import PhotoUnderstanding

    assert await db.get(PhotoUnderstanding, (fid, "place")) is None  # still waiting, not failed
    status = await places.status(db)
    assert status["places"] == 0 and status["error"]
    got = (await client.get("/api/photos/understanding", headers=_auth(user))).json()
    assert {s["stage"]: s for s in got["stages"]}["place"].get("waiting")
    # Once the files are there (or the network's back), the admin retries.
    await db.rollback()  # (this test's reads would hold up the load)
    _gazetteer(places.local_dir())
    await places.reset_failure()
    await tick(budget=10)
    assert (await db.get(PhotoUnderstanding, (fid, "place"), populate_existing=True)).state == "done"

"""Importing a Google Takeout (WP-10.2): the right dates, places and albums,
favourites starred, archived kept archived, Drive files kept in their
folders — and importing it again adds nothing."""
from __future__ import annotations

import io
import json
import subprocess
import uuid
import zipfile
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import func, select


def _jpeg(colour) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (16, 12), colour).save(buf, "JPEG")  # no EXIF: the date has to come from Google
    return buf.getvalue()


def _heic() -> bytes:
    import pillow_heif
    from PIL import Image

    pillow_heif.register_heif_opener()
    buf = io.BytesIO()
    Image.new("RGB", (16, 12), (90, 90, 200)).save(buf, "HEIF")
    return buf.getvalue()


def _mov(tmp_path) -> bytes:
    out = tmp_path / "clip.mov"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=1:size=160x120:rate=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)],
        check=True, timeout=60,
    )
    return out.read_bytes()


def _xlsx() -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    wb.active["A1"] = "Budget"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _sidecar(title, ts, lat=0.0, lon=0.0, **extra):
    return json.dumps({"title": title, "photoTakenTime": {"timestamp": str(ts)},
                       "geoData": {"latitude": lat, "longitude": lon}, **extra}).encode()


T2019 = int(datetime(2019, 6, 1, 9, tzinfo=timezone.utc).timestamp())
T2020 = int(datetime(2020, 8, 17, 12, tzinfo=timezone.utc).timestamp())


def make_takeout(tmp_path):
    P = "Takeout/Google Photos/"
    one = {
        P + "Photos from 2019/IMG_0001.jpg": _jpeg((1, 2, 3)),
        P + "Photos from 2019/IMG_0002.HEIC": _heic(),
        P + "Photos from 2019/IMG_0002.MOV": _mov(tmp_path),
        P + "Holiday in Noosa/IMG_0001.jpg": _jpeg((1, 2, 3)),
        P + "Holiday in Noosa/metadata.json": json.dumps({"title": "Holiday in Noosa"}).encode(),
        P + "Photos from 2020/IMG_0003.jpg": _jpeg((10, 11, 12)),
        "Takeout/Drive/Plans/Budget.xlsx": _xlsx(),
    }
    two = {
        P + "Photos from 2019/IMG_0001.jpg.supplemental-metadata.json": _sidecar("IMG_0001.jpg", T2019, -26.39, 153.09, description="Noosa main beach", favorited=True),
        P + "Photos from 2019/IMG_0002.HEIC.supplemental-metadata.json": _sidecar("IMG_0002.HEIC", T2019 + 60),
        P + "Holiday in Noosa/IMG_0001.jpg.supplemental-metadata.json": _sidecar("IMG_0001.jpg", T2019),
        P + "Photos from 2020/IMG_0003.jpg.supplemental-metadata.json": _sidecar("IMG_0003.jpg", T2020, archived=True),
    }
    paths = []
    for i, members in enumerate((one, two)):
        path = tmp_path / f"takeout-00{i + 1}.zip"
        with zipfile.ZipFile(path, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        paths.append(path)
    return paths


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    up = tmp_path / "uploads"
    up.mkdir()
    monkeypatch.setattr(storage, "UPLOAD_ROOT", up.resolve())
    return up


@pytest.fixture
async def client(db, root, monkeypatch):
    from app import rate_limit
    from app.config import get_settings
    from app.imports import jobs, run
    from app.main import app
    from app.tasks import queue

    monkeypatch.setattr(get_settings(), "TUS_HOOK_SECRET", None)

    async def index_inline(job_id):
        await jobs.index(job_id)

    async def run_inline(job_id):
        await run.run(job_id)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(jobs, "enqueue_index", index_inline)
    monkeypatch.setattr(run, "enqueue_run", run_inline)
    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(queue, "enqueue_office_text", nothing)
    import app.notifications.dispatch as dispatch

    async def notify_user(**kw):
        return None

    monkeypatch.setattr(dispatch, "notify_user", notify_user)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _import(client, user, paths):
    from tests.test_takeout_index_wp101 import _upload_part

    job = (await client.post("/api/imports", json={"source": "takeout"}, headers=_auth(user))).json()
    for path in paths:
        await _upload_part(client, user, job["id"], path)
    await client.post(f"/api/imports/{job['id']}/check", headers=_auth(user))
    r = await client.post(f"/api/imports/{job['id']}/start", headers=_auth(user))
    assert r.status_code == 200, r.text
    return (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()


async def _path(db, folder_id):
    from app.files.models import FileFolder

    names = []
    while folder_id is not None:
        f = await db.get(FileFolder, folder_id)
        names.append(f.name)
        folder_id = f.parent_id
    return names[::-1]


@pytest.mark.asyncio
async def test_a_takeout_lands_with_its_dates_places_and_albums(client, db, user, tmp_path, root):
    from app.files.media_meta import extract_and_store
    from app.files.models import FileMedia, UserFile
    from app.imports.models import FileImportMeta
    from app.photos.album_models import Album, AlbumItem
    from app.photos.models import PhotoAsset

    paths = make_takeout(tmp_path)
    job = await _import(client, user, paths)
    assert job["state"] == "done", (job["error"], job["progress"])
    p = job["progress"]
    assert (p["imported"], p["duplicates"], p["failed"], p["albums"], p["drive"]) == (5, 0, 0, 1, 1), p
    assert not (root / ".imports" / job["id"]).exists()  # the parts are gone

    files = {f.filename: f for f in (await db.execute(select(UserFile).where(UserFile.user_id == user.id))).scalars()}
    beach = files["IMG_0001.jpg"]
    assert await _path(db, beach.folder_id) == ["Photos", "2019", "06"]
    assert beach.starred_at is not None  # a Google favourite
    meta = await db.get(FileImportMeta, beach.id)
    assert (meta.lat, meta.lon, meta.description) == (-26.39, 153.09, "Noosa main beach")
    assert await _path(db, files["Budget.xlsx"].folder_id) == ["Google Drive", "Plans"]

    # The media worker reads Google's date and place where the photo has none.
    for f in files.values():
        if f.mime_type.startswith(("image/", "video/")):
            await extract_and_store(f.id)
    m = await db.get(FileMedia, beach.id, populate_existing=True)
    assert m.taken_at.timestamp() == T2019 and m.taken_at_source == "sidecar" and (m.lat, m.lon) == (-26.39, 153.09)
    archived = await db.get(PhotoAsset, files["IMG_0003.jpg"].id, populate_existing=True)
    assert archived is not None and archived.archived_at is not None

    album = (await db.execute(select(Album).where(Album.owner_id == user.id))).scalars().one()
    assert album.title == "Holiday in Noosa"
    assert [i.file_id for i in (await db.execute(select(AlbumItem).where(AlbumItem.album_id == album.id))).scalars()] == [beach.id]

    # Importing the same Takeout again adds nothing.
    again = await _import(client, user, paths)  # the very same parts, uploaded again
    q = again["progress"]
    assert again["state"] == "done" and (q["imported"], q["duplicates"], q["albums"]) == (0, 5, 0), q
    count = await db.scalar(select(func.count(UserFile.id)).where(UserFile.user_id == user.id, UserFile.trashed_at.is_(None)))
    assert count == len(files)
    assert await db.scalar(select(func.count(Album.id)).where(Album.owner_id == user.id)) == 1


@pytest.mark.asyncio
async def test_a_photo_promptly_won_t_take_is_reported_not_fatal(client, db, user, tmp_path):
    P = "Takeout/Google Photos/Photos from 2019/"
    path = tmp_path / "takeout-001.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(P + "good.jpg", _jpeg((5, 5, 5)))
        zf.writestr(P + "fake.jpg", b"this is not a jpeg at all")
    job = await _import(client, user, [path])
    p = job["progress"]
    assert job["state"] == "done" and p["imported"] == 1 and p["failed"] == 1
    assert p["failures"][0]["name"] == "fake.jpg"

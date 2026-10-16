"""Phone photos and videos (WP-7.3): HEIC / AVIF / MOV / MP4 accepted and
previewable, camera originals stored after ExifTool vouches for them, and
each photo's or video's metadata — when, where, size, camera, duration,
Live Photo pairing — read on the worker, with people's corrections on top."""
from __future__ import annotations

import io
import subprocess
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from PIL import Image

import app.files.imaging  # noqa: F401 — HEIC opener


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture
def inline_media(monkeypatch):
    """The worker isn't running in tests — read metadata in-process."""
    from app.tasks import queue

    async def inline(file_id):
        from app.files.media_meta import extract_and_store

        await extract_and_store(file_id)

    monkeypatch.setattr(queue, "enqueue_media", inline)


@pytest.fixture
async def client(db, root, inline_media):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _image(fmt: str, size=(80, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "teal").save(buf, format=fmt)
    return buf.getvalue()


def _tagged(tmp_path, name: str, data: bytes, *tags: str) -> bytes:
    p = tmp_path / f"src-{uuid.uuid4().hex}-{name}"
    p.write_bytes(data)
    subprocess.run(["exiftool", "-q", "-overwrite_original", *tags, str(p)], check=True)
    return p.read_bytes()


def _video(tmp_path, name: str, *meta: str) -> bytes:
    p = tmp_path / f"src-{uuid.uuid4().hex}-{name}"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
         "-pix_fmt", "yuv420p", *meta, str(p)],
        check=True,
    )
    return p.read_bytes()


async def _upload(client, user, name, data, mime="application/octet-stream", last_modified=None):
    form = {"scope": "mine"}
    if last_modified is not None:
        form["last_modified"] = str(last_modified)
    return await client.post("/api/files/", files={"file": (name, data, mime)}, data=form, headers=_auth(user))


# ---------------------------------------------------------------- formats


@pytest.mark.asyncio
async def test_an_iphone_heic_is_accepted_read_and_thumbnailed(client, user, tmp_path):
    data = _tagged(
        tmp_path, "IMG_0001.heic", _image("HEIF", (120, 90)),
        "-DateTimeOriginal=2024:07:14 18:30:05", "-OffsetTimeOriginal=+02:00",
        "-GPSLatitude=48.8584", "-GPSLatitudeRef=N", "-GPSLongitude=2.2945", "-GPSLongitudeRef=E",
        "-Make=Apple", "-Model=iPhone 15 Pro",
    )
    r = await _upload(client, user, "IMG_0001.HEIC", data, "image/heic")
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert r.json()["mime_type"] == "image/heic"
    info = (await client.get(f"/api/files/{fid}/media", headers=_auth(user))).json()
    assert info["taken_at_source"] == "exif" and info["tz_offset"] == 120
    # 18:30 at +02:00 is 16:30 UTC.
    assert datetime.fromisoformat(info["taken_at"]) == datetime(2024, 7, 14, 16, 30, 5, tzinfo=timezone.utc)
    assert info["location"] == {"lat": 48.8584, "lon": 2.2945, "edited": False}
    assert (info["width"], info["height"]) == (120, 90)
    assert info["camera"] == "Apple iPhone 15 Pro" and info["can_edit"] is True

    thumb = await client.get(f"/api/files/{fid}/thumbnail?size=1024", headers=_auth(user))
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_a_mov_gets_its_date_length_and_codec(client, user, tmp_path):
    data = _video(tmp_path, "clip.mov", "-metadata", "creation_time=2023-12-24T20:15:00Z")
    r = await _upload(client, user, "clip.mov", data, "video/quicktime")
    assert r.status_code == 201, r.text
    info = (await client.get(f"/api/files/{r.json()['id']}/media", headers=_auth(user))).json()
    assert info["kind"] == "video" and info["taken_at_source"] == "quicktime"
    assert datetime.fromisoformat(info["taken_at"]) == datetime(2023, 12, 24, 20, 15, tzinfo=timezone.utc)
    assert 1900 <= info["duration_ms"] <= 2100 and info["codec"]
    assert (info["width"], info["height"]) == (320, 240)


@pytest.mark.asyncio
async def test_without_a_date_inside_the_device_date_then_the_upload_is_used(client, user):
    stamp = int(datetime(2021, 5, 1, 9, 0, tzinfo=timezone.utc).timestamp() * 1000)
    r = await _upload(client, user, "scan.png", _image("PNG"), "image/png", last_modified=stamp)
    info = (await client.get(f"/api/files/{r.json()['id']}/media", headers=_auth(user))).json()
    assert info["taken_at_source"] == "client"
    assert datetime.fromisoformat(info["taken_at"]) == datetime(2021, 5, 1, 9, 0, tzinfo=timezone.utc)
    r = await _upload(client, user, "plain.png", _image("PNG"), "image/png")
    info = (await client.get(f"/api/files/{r.json()['id']}/media", headers=_auth(user))).json()
    assert info["taken_at_source"] == "upload"


@pytest.mark.asyncio
async def test_avif_tiff_and_camera_originals(client, user, root):
    assert (await _upload(client, user, "a.avif", _image("AVIF"), "image/avif")).status_code == 201
    assert (await _upload(client, user, "scan.tif", _image("TIFF"), "image/tiff")).status_code == 201
    # A DNG is TIFF-based: ExifTool vouches for it.
    assert (await _upload(client, user, "raw.dng", _image("TIFF"))).status_code == 201
    # Something calling itself a Canon raw that isn't one.
    r = await _upload(client, user, "IMG_1.CR3", b"<html>not a raw</html>" * 20)
    assert r.status_code == 400
    r = await _upload(client, user, "IMG_2.NEF", _image("PNG"))
    assert r.status_code == 400
    assert not list(root.rglob("*.CR3")) and not list(root.rglob("*.nef"))


@pytest.mark.asyncio
async def test_a_heic_in_a_document_is_kept_as_a_jpeg(client, user):
    r = await client.post("/api/documents", json={"scope": "mine", "name": "Trip"}, headers=_auth(user))
    doc = r.json()["id"]
    r = await client.post(f"/api/documents/{doc}/assets", files={"file": ("p.heic", _image("HEIF"), "image/heic")},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["mime_type"] == "image/jpeg" and body["filename"].endswith(".jpg")


def test_the_models_get_heic_and_avif_as_jpeg(root, user):
    from app.files.models import UserFile
    from app.files.prompt import build_image_parts
    from app.files.storage import absolute_path

    rows = []
    for ext, fmt, mime in ((".heic", "HEIF", "image/heic"), (".avif", "AVIF", "image/avif")):
        rel = f"u_{user.id}/{uuid.uuid4()}{ext}"
        absolute_path(rel).parent.mkdir(parents=True, exist_ok=True)
        absolute_path(rel).write_bytes(_image(fmt, (400, 300)))
        rows.append(UserFile(id=uuid.uuid4(), user_id=user.id, filename=f"p{ext}", original_filename=f"p{ext}",
                             mime_type=mime, size_bytes=1, storage_path=rel))
    parts, warnings = build_image_parts(rows)
    assert not warnings and len(parts) == 2
    assert all(p.url.startswith("data:image/jpeg;base64,") for p in parts)


# ---------------------------------------------------------------- metadata rules


def test_taken_at_precedence_and_parsing():
    from app.files.media_meta import parse, parse_datetime, taken_from_tags

    assert parse_datetime("0000:00:00 00:00:00") is None
    assert parse_datetime("2024:02:30 10:00:00") is None
    assert parse_datetime("2024:01:02 03:04:05.12+05:30")[1] == 330
    # EXIF beats QuickTime; no offset → the wall time as-is.
    t = taken_from_tags({"EXIF:DateTimeOriginal": "2020:01:01 12:00:00", "QuickTime:CreateDate": "2019:01:01 00:00:00"})
    assert t == (datetime(2020, 1, 1, 12, tzinfo=timezone.utc), "exif", None)
    # Apple's CreationDate keeps the offset; CreateDate is UTC.
    t = taken_from_tags({"QuickTime:CreationDate": "2022:06:01 08:00:00-04:00", "QuickTime:CreateDate": "2022:06:01 12:00:00"})
    assert t == (datetime(2022, 6, 1, 12, tzinfo=timezone.utc), "quicktime", -240)
    out = parse({"Composite:GPSLatitude": 0, "Composite:GPSLongitude": 0, "EXIF:Orientation": 6,
                 "Composite:ImageSize": "4032 3024", "XMP:MotionPhoto": 1})
    assert "lat" not in out  # 0,0 is "no fix", not the Gulf of Guinea
    assert (out["width"], out["height"]) == (3024, 4032) and out["motion_embedded"] is True


@pytest.mark.asyncio
async def test_a_live_photo_pairs_its_photo_and_video(client, db, user, monkeypatch):
    from app.files import media_meta
    from app.files.models import FileMedia

    tags_by_name = {
        "IMG_7.jpg": {"MakerNotes:ContentIdentifier": "A1B2-C3", "EXIF:DateTimeOriginal": "2024:01:01 10:00:00"},
        "IMG_7.mov": {"QuickTime:ContentIdentifier": "A1B2-C3", "QuickTime:CreateDate": "2024:01:01 10:00:00"},
    }
    names: dict[str, str] = {}

    def fake_tags(path):
        return tags_by_name[names[path.rsplit("/", 1)[-1]]]

    monkeypatch.setattr(media_meta, "read_tags", fake_tags)
    monkeypatch.setattr(media_meta, "probe_video", lambda path: {})
    ids = {}
    for name, data, mime in (("IMG_7.jpg", _image("JPEG"), "image/jpeg"),
                             ("IMG_7.mov", b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  " + b"\x00" * 200, "video/quicktime")):
        # Register the stored name first so the fake reader can find it.
        from app.files import storage as st

        orig = st.storage_path_for

        def capture(user_id, file_id, ext, _name=name):
            p = orig(user_id, file_id, ext)
            names[p.rsplit("/", 1)[-1]] = _name
            return p

        monkeypatch.setattr("app.files.router.storage_path_for", capture)
        r = await _upload(client, user, name, data, mime)
        assert r.status_code == 201, r.text
        ids[name] = r.json()["id"]
    photo = await db.get(FileMedia, uuid.UUID(ids["IMG_7.jpg"]), populate_existing=True)
    video = await db.get(FileMedia, uuid.UUID(ids["IMG_7.mov"]), populate_existing=True)
    assert str(photo.live_pair_file_id) == ids["IMG_7.mov"]
    assert str(video.live_pair_file_id) == ids["IMG_7.jpg"]


@pytest.mark.asyncio
async def test_corrections_win_and_can_be_undone(client, db, user, tmp_path):
    from app.auth.models import User

    data = _tagged(tmp_path, "a.jpg", _image("JPEG"), "-DateTimeOriginal=2019:03:03 03:03:03",
                   "-GPSLatitude=10", "-GPSLatitudeRef=N", "-GPSLongitude=20", "-GPSLongitudeRef=E")
    fid = (await _upload(client, user, "a.jpg", data, "image/jpeg")).json()["id"]
    r = await client.patch(f"/api/files/{fid}/media", json={"taken_at": "2019-03-04T12:00:00Z", "lat": 51.5, "lon": -0.12},
                           headers=_auth(user))
    info = r.json()
    assert info["taken_at_source"] == "edited" and info["location"] == {"lat": 51.5, "lon": -0.12, "edited": True}
    info = (await client.patch(f"/api/files/{fid}/media", json={"hide_location": True}, headers=_auth(user))).json()
    assert info["location"] is None and info["has_original_location"] is True
    info = (await client.patch(f"/api/files/{fid}/media", json={"reset_taken_at": True, "reset_location": True},
                               headers=_auth(user))).json()
    assert info["taken_at_source"] == "exif" and info["location"]["lat"] == 10.0
    # Someone else can't.
    other = User(email=f"o-{uuid.uuid4().hex[:6]}@x.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x")
    db.add(other)
    await db.commit()
    assert (await client.patch(f"/api/files/{fid}/media", json={"hide_location": True}, headers=_auth(other))).status_code in (403, 404)

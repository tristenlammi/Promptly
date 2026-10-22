"""Public album links (WP-9.5, Part E PH-1): a grandparent opens "Holiday
2026" from a link — no account, and no location in anything they get."""
from __future__ import annotations

import io
import subprocess
import uuid
import zipfile
from datetime import datetime, timezone

import httpx
import pytest

from tests.test_understanding_ph21 import _photos_folder  # photos live in the Photos folder


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture
async def client(db, root):
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


def _gps_jpeg(tmp_path) -> bytes:
    """A JPEG that says where it was taken (GPS in its EXIF)."""
    from PIL import Image

    p = tmp_path / f"g{uuid.uuid4().hex}.jpg"
    Image.new("RGB", (32, 24), (10, 120, 200)).save(p, "JPEG")
    subprocess.run(
        ["exiftool", "-q", "-overwrite_original", "-GPSLatitude=-26.39", "-GPSLatitudeRef=S",
         "-GPSLongitude=153.09", "-GPSLongitudeRef=E", str(p)],
        check=True, timeout=30,
    )
    return p.read_bytes()


def _has_gps(data: bytes) -> bool:
    out = subprocess.run(["exiftool", "-j", "-GPSLatitude", "-"], input=data, capture_output=True, timeout=30)
    return b"GPSLatitude" in out.stdout


async def _photo(db, user, name, data, day):
    from app.files import blobstore
    from app.files.models import FileMedia, UserFile
    from app.files.storage import storage_path_for
    from app.photos.library import sync

    fid = uuid.uuid4()
    rel = storage_path_for(user.id, fid, ".jpg")
    await blobstore.put_bytes(rel, data)
    db.add(UserFile(id=fid, user_id=user.id, folder_id=(await _photos_folder(db, user)).id, filename=name, original_filename=name, mime_type="image/jpeg",
                    size_bytes=len(data), storage_path=rel))
    await db.flush()
    db.add(FileMedia(file_id=fid, kind="image", taken_at=datetime(2026, 7, day, tzinfo=timezone.utc),
                     lat=-26.39, lon=153.09, extracted_at=datetime.now(timezone.utc)))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    return str(fid)


@pytest.mark.asyncio
async def test_a_link_shows_the_album_to_anyone_without_where(client, db, user, tmp_path):
    from app.files.derivatives import rendition_path

    a = await _photo(db, user, "noosa.jpg", _gps_jpeg(tmp_path), 3)
    b = await _photo(db, user, "beach.jpg", _gps_jpeg(tmp_path), 5)
    aid = (await client.post("/api/photos/albums", json={"title": "Holiday 2026", "file_ids": [a, b]}, headers=_auth(user))).json()["id"]
    # The media worker's tile for one of them.
    tile = rendition_path(a, "thumb.webp")
    tile.parent.mkdir(parents=True, exist_ok=True)
    tile.write_bytes(b"RIFF....WEBP")
    from app.files.models import FileMedia

    m = await db.get(FileMedia, uuid.UUID(a))
    m.derivative_state, m.renditions = "ready", {"thumb.webp": {"bytes": 12}}
    await db.commit()

    r = await client.post(f"/api/photos/albums/{aid}/links", json={}, headers=_auth(user))
    assert r.status_code == 201
    link = r.json()
    assert link["path"].startswith("/s/") and link["keep_location"] is False and link["qr"].startswith("data:image/png")
    token = link["path"].split("/")[-1]

    # No account: the landing page learns it's an album, then the gallery.
    meta = (await client.get(f"/api/s/{token}/meta")).json()
    assert meta["resource_type"] == "album" and meta["filename"] == "Holiday 2026"
    page = (await client.get(f"/api/s/{token}/album")).json()
    assert page["title"] == "Holiday 2026" and page["count"] == 2
    assert [i["filename"] for i in page["items"]] == ["beach.jpg", "noosa.jpg"]
    assert all("lat" not in i and "location" not in i for i in page["items"])
    noosa = next(i for i in page["items"] if i["filename"] == "noosa.jpg")
    assert (await client.get(noosa["thumb"])).content == b"RIFF....WEBP"

    # The original comes without its location; so does every photo in the zip.
    original = await client.get(noosa["original"])
    assert original.status_code == 200 and not _has_gps(original.content)
    z = zipfile.ZipFile(io.BytesIO((await client.get(page["zip"])).content))
    assert sorted(z.namelist()) == ["beach.jpg", "noosa.jpg"]
    assert not any(_has_gps(z.read(n)) for n in z.namelist())

    # A photo taken out of the album is out of reach through the link.
    await client.request("DELETE", f"/api/photos/albums/{aid}/items", json={"file_ids": [a]}, headers=_auth(user))
    assert (await client.get(noosa["original"])).status_code == 404

    # Turned off: gone at once.
    assert (await client.delete(f"/api/photos/albums/{aid}/links/{link['id']}", headers=_auth(user))).status_code == 204
    assert (await client.get(f"/api/s/{token}/album")).status_code == 410


@pytest.mark.asyncio
async def test_a_link_can_keep_location_and_only_the_owner_makes_links(client, db, user, tmp_path):
    from app.auth.models import User

    a = await _photo(db, user, "home.jpg", _gps_jpeg(tmp_path), 1)
    aid = (await client.post("/api/photos/albums", json={"title": "Garden", "file_ids": [a]}, headers=_auth(user))).json()["id"]
    link = (await client.post(f"/api/photos/albums/{aid}/links", json={"keep_location": True}, headers=_auth(user))).json()
    token = link["path"].split("/")[-1]
    item = (await client.get(f"/api/s/{token}/album")).json()["items"][0]
    assert _has_gps((await client.get(item["original"])).content)

    other = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    await client.post(f"/api/photos/albums/{aid}/members", json={"user_id": str(other.id), "role": "contributor"}, headers=_auth(user))
    assert (await client.post(f"/api/photos/albums/{aid}/links", json={}, headers=_auth(other))).status_code == 404
    # The owner's list of their links names the album.
    rows = (await client.get("/api/files/share-links", headers=_auth(user))).json()["links"]
    assert any(r["resource_type"] == "album" and r["resource_name"] == "Garden" for r in rows)

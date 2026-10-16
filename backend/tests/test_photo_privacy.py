"""Photo location: kept for you, removed on the way out (WP-0.5, D13)."""
from __future__ import annotations

import io
import secrets
import subprocess
import uuid
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app.auth.utils import create_access_token
from app.files import storage


def _jpeg_with_gps(orientation: int = 6) -> bytes:
    im = Image.new("RGB", (40, 20), (200, 10, 10))
    ex = Image.Exif()
    ex[0x0112] = orientation
    ex[0x010F] = "Canon"
    ex[0x8825] = {1: "S", 2: (27.0, 28.0, 0.0), 3: "E", 4: (153.0, 1.0, 0.0)}
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=ex.tobytes(), quality=90)
    return buf.getvalue()


def _tags(raw: bytes) -> str:
    return subprocess.run(["exiftool", "-s", "-G", "-"], input=raw, capture_output=True).stdout.decode()


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path.resolve()


@pytest.fixture
async def client(db, monkeypatch):
    from app import rate_limit
    from app.main import app
    from app.tasks import events

    # An upload fires a fire-and-forget automation dispatch; left running
    # past the test it holds a pooled connection on a loop that's gone.
    monkeypatch.setattr(events, "emit_user_event", lambda **kw: None)

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def _upload(client, user, raw: bytes):
    token = create_access_token(user.id, token_version=user.token_version)
    r = await client.post(
        "/api/files/", files={"file": ("trip.jpg", raw, "image/jpeg")}, data={"scope": "mine"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    return r.json(), token


async def test_uploads_keep_the_original_byte_for_byte(db, user, root, client):
    raw = _jpeg_with_gps()

    meta, _ = await _upload(client, user, raw)

    from app.files.models import UserFile

    row = await db.get(UserFile, uuid.UUID(meta["id"]))
    assert (root / row.storage_path).read_bytes() == raw
    assert row.size_bytes == len(raw)


@pytest.mark.parametrize("keep", [False, True])
async def test_share_links_strip_location_unless_told_not_to(db, user, root, client, keep):
    raw = _jpeg_with_gps()
    meta, token = await _upload(client, user, raw)
    r = await client.post(
        f"/api/files/{meta['id']}/share-links", json={"access_mode": "public", "keep_location": keep},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201 and r.json()["keep_location"] is keep

    got = (await client.get(f"/api/s/{r.json()['token']}/download")).content

    tags = _tags(got)
    if keep:
        assert got == raw
    else:
        assert "GPS" not in tags and "Canon" not in tags
        assert "Rotate 90 CW" in tags  # still displays the right way up
        a, b = Image.open(io.BytesIO(raw)), Image.open(io.BytesIO(got))
        assert list(a.getdata()) == list(b.getdata())  # same pixels


def test_photos_sent_to_an_ai_provider_carry_no_location():
    from app.files.prompt import _prepare_image_for_vision

    payload, mime = _prepare_image_for_vision(_jpeg_with_gps(), "image/jpeg")

    assert mime == "image/jpeg" and "GPS" not in _tags(payload)


def test_resized_ai_images_are_upright():
    """A sideways-stored phone photo (EXIF says rotate) must reach the model
    upright now that originals keep their orientation."""
    from app.files import prompt

    im = Image.new("RGB", (3000, 1000), (0, 0, 0))
    ex = Image.Exif()
    ex[0x0112] = 6  # rotate 90 CW
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=ex.tobytes())

    payload, _ = prompt._prepare_image_for_vision(buf.getvalue(), "image/jpeg")
    w, h = Image.open(io.BytesIO(payload)).size
    assert h > w

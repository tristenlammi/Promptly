"""The photo viewer's backend part (WP-9.3): a motion photo's moment of video
is pulled out of the picture, so the viewer can play it."""
from __future__ import annotations

import io
import subprocess
import uuid

import pytest

from tests.test_understanding_ph21 import _photos_folder  # photos live in the Photos folder


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


def _clip(tmp_path) -> bytes:
    out = tmp_path / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=1:size=320x240:rate=15",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
        check=True, timeout=60,
    )
    return out.read_bytes()


def _jpeg() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 140, 200)).save(buf, "JPEG")
    return buf.getvalue()


def test_finding_the_clip_after_the_picture(tmp_path):
    from app.files.derivatives import motion_clip_offset

    clip = _clip(tmp_path)
    still = _jpeg()
    assert motion_clip_offset(still + clip) == len(still)
    # A picture with nothing after it — or a HEIC, whose own ftyp opens the
    # file — has no clip.
    assert motion_clip_offset(still) is None
    heic_like = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64
    assert motion_clip_offset(heic_like) is None


def test_a_motion_photo_gets_a_playable_clip(root, tmp_path):
    from app.files.derivatives import make_renditions, rendition_path

    fid = uuid.uuid4()
    src = tmp_path / "PXL_20260101_MP.jpg"
    src.write_bytes(_jpeg() + _clip(tmp_path))
    out, thumbhash = make_renditions(src, fid, "image", motion=True)
    assert {"thumb.webp", "preview.webp", "video.mp4"} <= set(out)
    assert out["video.mp4"]["motion"] is True and thumbhash
    assert rendition_path(fid, "video.mp4").read_bytes()[4:8] == b"ftyp"

    # An ordinary photo: just the still.
    plain = tmp_path / "plain.jpg"
    plain.write_bytes(_jpeg())
    out2, _ = make_renditions(plain, uuid.uuid4(), "image", motion=True)
    assert "video.mp4" not in out2


@pytest.mark.asyncio
async def test_photos_without_a_zone_follow_yours(db, user):
    """A screenshot or a date typed in carries no time zone: it's filed by
    the owner's — and moves when theirs changes. A camera's own offset wins."""
    from datetime import datetime, timezone

    import httpx

    from app import rate_limit
    from app.auth.utils import create_access_token
    from app.files.models import FileMedia, UserFile
    from app.main import app
    from app.photos.library import sync
    from app.photos.models import PhotoAsset

    instant = datetime(2025, 12, 31, 20, 30, tzinfo=timezone.utc)  # 1 Jan 2026, 06:30 in Brisbane
    ids = {}
    # An older camera writes its clock with no zone: that wall time stays put.
    for name, offset, source in (("screenshot.png", None, None), ("camera.jpg", -300, "exif"), ("old.jpg", None, "exif")):
        fid = uuid.uuid4()
        db.add(UserFile(id=fid, user_id=user.id, folder_id=(await _photos_folder(db, user)).id, filename=name, original_filename=name, mime_type="image/png",
                        size_bytes=1, storage_path=f"u/{fid}"))
        await db.flush()
        db.add(FileMedia(file_id=fid, kind="image", taken_at=instant, tz_offset=offset, taken_at_source=source, extracted_at=instant))
        await db.flush()
        await sync(db, fid)
        ids[name] = fid
    await db.commit()
    local = lambda n: db.get(PhotoAsset, ids[n], populate_existing=True)  # noqa: E731
    assert (await local("screenshot.png")).taken_local == datetime(2025, 12, 31, 20, 30)  # no zone yet: UTC
    assert (await local("camera.jpg")).taken_local == datetime(2025, 12, 31, 15, 30)  # its own -05:00

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            auth = {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}
            r = await c.patch("/api/auth/me/preferences", json={"timezone": "Australia/Brisbane"}, headers=auth)
            assert r.status_code == 200, r.text
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True
    assert (await local("screenshot.png")).taken_local == datetime(2026, 1, 1, 6, 30)
    assert (await local("camera.jpg")).taken_local == datetime(2025, 12, 31, 15, 30)  # unchanged
    old = await local("old.jpg")
    assert old.taken_local == datetime(2025, 12, 31, 20, 30)  # 8:30 pm on its clock, now read as Brisbane's
    assert old.taken_at == datetime(2025, 12, 31, 10, 30, tzinfo=timezone.utc)

    # And a photo read after that is filed in the zone straight away.
    from app.auth.models import User

    me = await db.get(User, user.id, populate_existing=True)
    assert me.settings["timezone"] == "Australia/Brisbane"
    fid = uuid.uuid4()
    db.add(UserFile(id=fid, user_id=user.id, folder_id=(await _photos_folder(db, user)).id, filename="later.png", original_filename="later.png", mime_type="image/png",
                    size_bytes=1, storage_path=f"u/{fid}"))
    await db.flush()
    db.add(FileMedia(file_id=fid, kind="image", taken_at=instant, extracted_at=instant))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    assert (await db.get(PhotoAsset, fid)).taken_local == datetime(2026, 1, 1, 6, 30)

"""Editing (PH-7): rotate + crop + brighten is kept beside the untouched
original; the grid shows the edited tile at its edited size; "Download
edited" is the full-size edit; Revert goes back; only the owner edits."""
from __future__ import annotations

import io

import pytest
from PIL import Image
from sqlalchemy import text

from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys, _photo  # noqa: F401


def _claim(url: str):
    from app.files import media_urls

    return media_urls.verify(url.rstrip("/").rsplit("/", 1)[-1])


@pytest.mark.asyncio
async def test_edit_rotate_crop_export_revert(client, db, user, root):
    from app.files.derivatives import rendition_path
    from app.files.models import FileMedia, UserFile
    from app.files.storage import absolute_path

    fid = await _photo(db, user, preview=b"x")
    # The original: 400×200, left half red, right half blue.
    im = Image.new("RGB", (400, 200), (0, 0, 255))
    im.paste((255, 0, 0), (0, 0, 200, 200))
    row = await db.get(UserFile, fid)
    path = absolute_path(row.storage_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=95)
    original = path.read_bytes()
    media = await db.get(FileMedia, fid)
    media.width, media.height, media.orientation = 400, 200, 1
    media.renditions = {"thumb.webp": {"width": 320, "height": 160, "bytes": 10}, "preview.webp": {"width": 400, "height": 200, "bytes": 20}}
    await db.commit()

    ops = {"rotate": 90, "crop": {"x": 0, "y": 0, "w": 1, "h": 0.5}, "brightness": 0.1}
    r = await client.put(f"/api/photos/files/{fid}/edit", json=ops, headers=_auth(user))
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["ops"]["rotate"] == 90 and got["ops"]["crop"]["h"] == 0.5
    item = got["item"]
    assert item["edited"] is True and (item["width"], item["height"]) == (200, 200)
    assert _claim(item["thumb"]).rendition == "thumb_edit"
    assert rendition_path(fid, "preview.edit.webp").is_file() and rendition_path(fid, "thumb.edit.webp").is_file()
    assert path.read_bytes() == original  # never touched

    # The viewer's links: the edited preview, and the original's for the editor.
    links = (await client.get(f"/api/files/{fid}/signed-urls", headers=_auth(user))).json()
    assert links["edited"] is True and _claim(links["preview"]).rendition == "preview_edit"
    assert _claim(links["source"]).rendition == "preview"

    # Download edited: the full-size edit — turned clockwise, the red half on top, cropped to it.
    r = await client.get(f"/api/photos/files/{fid}/edited", headers=_auth(user))
    assert r.status_code == 200 and "edited" in r.headers["content-disposition"]
    out = Image.open(io.BytesIO(r.content))
    assert out.size == (200, 200)
    red, green, blue = out.convert("RGB").getpixel((100, 100))
    assert red > 200 and blue < 60

    # Not theirs to edit.
    import uuid

    from app.auth.models import User

    other_user = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other_user)
    await db.commit()
    assert (await client.put(f"/api/photos/files/{fid}/edit", json=ops, headers=_auth(other_user))).status_code == 404

    # Revert: the original again, the edited renditions gone.
    r = await client.delete(f"/api/photos/files/{fid}/edit", headers=_auth(user))
    item = r.json()["item"]
    assert r.json()["ops"] is None and item["edited"] is False and (item["width"], item["height"]) == (400, 200)
    assert _claim(item["thumb"]).rendition == "thumb"
    assert not rendition_path(fid, "preview.edit.webp").exists()
    assert (await db.scalar(text("SELECT count(*) FROM photo_edits"))) == 0


@pytest.mark.asyncio
async def test_no_change_is_no_edit_and_videos_are_not_edited(client, db, user, root):
    vid = await _photo(db, user, kind="video")
    r = await client.put(f"/api/photos/files/{vid}/edit", json={"rotate": 90}, headers=_auth(user))
    assert r.status_code == 400

    from app.photos.edits import edited_size, is_identity, normalise

    assert is_identity({"rotate": 0, "crop": {"x": 0, "y": 0, "w": 1, "h": 1}, "brightness": 0})
    assert normalise({"rotate": 450})["rotate"] == 90
    assert edited_size(4000, 3000, {"rotate": 270, "crop": {"x": 0.25, "y": 0, "w": 0.5, "h": 1}}) == (1500, 4000)

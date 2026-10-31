"""Photo markup + the editor's ways out (PH-7 follow-up): pen / shapes /
text / blur / emoji / stickers are cleaned and clamped and drawn by the
server; "render" makes the unsaved edit (Copy / Download) and keeps
nothing; "Save as new" files a second photo beside the original with its
date and place, and leaves the original (and its own edit) alone."""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import select, text

from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _photo  # noqa: F401

RED = "#ff0000"


async def _real_photo(db, user, size=(400, 200), *, lat=None, lon=None):
    """A photo with real bytes: left half red, right half blue."""
    from app.files.models import FileMedia, UserFile
    from app.files.storage import absolute_path
    from app.photos.library import sync

    fid = await _photo(db, user, preview=b"x", lat=lat, lon=lon)
    im = Image.new("RGB", size, (0, 0, 255))
    im.paste((255, 0, 0), (0, 0, size[0] // 2, size[1]))
    row = await db.get(UserFile, fid)
    row.filename = "IMG_1234.jpg"
    path = absolute_path(row.storage_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=95)
    row.size_bytes = path.stat().st_size
    media = await db.get(FileMedia, fid)
    media.width, media.height, media.orientation = size[0], size[1], 1
    # Taken 2021-06-05 14:30 at UTC+10.
    media.taken_at, media.tz_offset, media.taken_at_source = datetime(2021, 6, 5, 4, 30, tzinfo=timezone.utc), 600, "exif"
    media.renditions = {"thumb.webp": {"width": 320, "height": 160, "bytes": 10}, "preview.webp": {"width": 400, "height": 200, "bytes": 20}}
    await sync(db, fid)
    await db.commit()
    return fid, path


async def _stranger(db):
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    return other


def test_markup_is_cleaned_and_clamped():
    from app.photos.edits import MAX_SHAPES, is_identity, normalise

    ops = normalise({"markup": [
        {"type": "pen", "color": "#00FF00", "width": 9, "points": [[0.1, 0.1], [2, -3]]},
        {"type": "pen", "color": RED, "points": [[0.1, 0.1], ["x", 1]]},  # a bad point: not drawn at all
        {"type": "pen", "color": "red", "width": 0.01, "points": [[0.1, 0.1], [0.2, 0.2]]},
        {"type": "arrow", "color": RED, "width": 0.01, "points": [[0, 0], [1, 1], [0.5, 0.5]]},
        {"type": "ellipse", "color": RED, "points": [[0.2, 0.2]]},  # needs two corners
        {"type": "text", "color": RED, "size": 5, "points": [[0.1, 0.1]], "text": "  hello\n  there  " + "x" * 400},
        {"type": "text", "color": RED, "points": [[0.1, 0.1]], "text": "   "},
        {"type": "blur", "points": [[0.9, 0.9], [-1, 0.2]]},
        {"type": "script", "points": [[0, 0]]},
        {"type": "emoji", "emoji": "\U0001F600", "points": [[0.5, 0.5]], "size": 7, "rotation": 270},
        {"type": "emoji", "emoji": "hello", "points": [[0.5, 0.5]]},
        {"type": "emoji", "emoji": "\U0001F600" * 9, "points": [[0.5, 0.5]]},
        {"type": "sticker", "sticker": "heart", "color": "#0000FF", "points": [[0.5, 0.5]], "size": 0.001},
        {"type": "sticker", "sticker": "sold", "color": "#0000ff", "points": [[0.5, 0.5]]},
        {"type": "sticker", "sticker": "../../etc/passwd", "points": [[0.5, 0.5]]},
    ]})
    m = ops["markup"]
    assert [s["type"] for s in m] == ["pen", "pen", "arrow", "text", "blur", "emoji", "sticker", "sticker"]
    pen = m[0]
    assert pen["color"] == "#00ff00" and pen["width"] == 0.15 and pen["points"] == [[0.1, 0.1], [1.5, -0.5]]
    assert m[1]["color"] == RED  # not #rrggbb: the default
    assert len(m[2]["points"]) == 2
    assert m[3]["size"] == 0.3 and m[3]["text"].startswith("hello there x") and len(m[3]["text"]) == 200
    assert m[4]["points"] == [[0.0, 0.2], [0.9, 0.9]]
    assert m[5]["size"] == 1.0 and m[5]["rotation"] == -90.0
    assert m[6] == {"type": "sticker", "sticker": "heart", "color": "#0000ff", "points": [[0.5, 0.5]], "size": 0.02, "rotation": 0.0}
    assert "color" not in m[7]  # a coloured sticker isn't tinted

    many = normalise({"markup": [{"type": "line", "color": RED, "points": [[0, 0], [1, 1]]}] * (MAX_SHAPES + 50)})
    assert len(many["markup"]) == MAX_SHAPES
    long = normalise({"markup": [{"type": "pen", "color": RED, "points": [[0.5, 0.5]] * 5000}]})
    assert len(long["markup"][0]["points"]) == 2000
    assert is_identity({"markup": [{"type": "nope"}]})
    assert not is_identity({"markup": [{"type": "line", "color": RED, "points": [[0, 0], [1, 1]]}]})


def test_markup_is_drawn():
    from app.photos.edits import draw_markup, normalise
    from app.photos.stickers import STICKERS, load

    for sid in STICKERS:  # every sticker is there and loads
        assert load(sid).size == (512, 512)

    white = Image.new("RGB", (400, 200), (255, 255, 255))
    ops = normalise({"markup": [
        {"type": "rect", "color": "#00ff00", "width": 0.04, "points": [[0.1, 0.1], [0.4, 0.9]]},
        {"type": "highlighter", "color": "#0000ff", "width": 0.1, "points": [[0.6, 0.5], [0.9, 0.5]]},
        {"type": "sticker", "sticker": "heart", "color": "#ff0000", "points": [[0.5, 0.5]], "size": 0.3},
        {"type": "text", "color": "#000000", "size": 0.1, "points": [[0.05, 0.85]], "text": "Hi"},
    ]})["markup"]
    out = draw_markup(white, ops)
    assert out.size == (400, 200) and out.mode == "RGB"
    r, g, b = out.getpixel((40, 100))  # the rectangle's left edge
    assert g > 200 and r < 80 and b < 80
    r, g, b = out.getpixel((320, 100))  # see-through blue
    assert b > 200 and 80 < r < 230
    r, g, b = out.getpixel((200, 100))  # the heart, tinted red
    assert r > 200 and g < 60 and b < 60
    assert white.getpixel((200, 100)) == (255, 255, 255)  # drawn on a copy

    # A blur box pixelates: a fine checkerboard becomes flat blocks.
    check = Image.new("RGB", (200, 200))
    check.putdata([(255, 255, 255) if (x + y) % 2 else (0, 0, 0) for y in range(200) for x in range(200)])
    out = draw_markup(check, normalise({"markup": [{"type": "blur", "points": [[0, 0], [0.5, 0.5]]}]})["markup"])
    block = out.crop((0, 0, 100, 100))
    assert len(set(block.getdata())) <= 4 and out.getpixel((150, 150)) == check.getpixel((150, 150))


def test_emoji_is_drawn_in_colour():
    from app.photos.edits import EMOJI_FONTS, draw_markup, normalise

    if not any(Path(p).is_file() for p in EMOJI_FONTS):
        pytest.skip("no colour emoji font in this image")
    white = Image.new("RGB", (300, 300), (255, 255, 255))
    out = draw_markup(white, normalise({"markup": [
        {"type": "emoji", "emoji": "\U0001F600", "points": [[0.5, 0.5]], "size": 0.5, "rotation": 30},
    ]})["markup"])
    r, g, b = out.getpixel((150, 150))
    assert r > 200 and g > 120 and b < 100  # the yellow face


@pytest.mark.asyncio
async def test_render_makes_the_unsaved_edit_and_keeps_nothing(client, db, user, root):
    from app.files.derivatives import rendition_path
    from app.files.models import FileMedia

    fid, path = await _real_photo(db, user, size=(3000, 1500))
    original = path.read_bytes()
    ops = {"rotate": 0, "markup": [{"type": "ellipse", "color": "#00ff00", "width": 0.03, "points": [[0.1, 0.1], [0.4, 0.9]]}]}
    r = await client.post(f"/api/photos/files/{fid}/render", json=ops, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png" and r.headers["cache-control"] == "no-store"
    im = Image.open(io.BytesIO(r.content))
    assert im.format == "PNG" and im.size == (2560, 1280)
    r_, g_, b_ = im.convert("RGB").getpixel((round(0.1 * 2560), 640))  # the ellipse's left edge
    assert g_ > 200 and r_ < 80

    r = await client.post(f"/api/photos/files/{fid}/render?format=jpeg", json={"crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}}, headers=_auth(user))
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(r.content)).size == (1500, 1500)  # full size

    # Nothing kept: no edit, no edited renditions, the original as it was.
    assert (await db.scalar(text("SELECT count(*) FROM photo_edits"))) == 0
    media = await db.get(FileMedia, fid, populate_existing=True)
    assert "edit" not in (media.renditions or {})
    assert not rendition_path(fid, "preview.edit.webp").exists()
    assert path.read_bytes() == original

    other = await _stranger(db)
    assert (await client.post(f"/api/photos/files/{fid}/render", json=ops, headers=_auth(other))).status_code == 404


@pytest.mark.asyncio
async def test_saved_markup_shows_in_the_edited_renditions_and_export(client, db, user, root):
    fid, _ = await _real_photo(db, user)
    ops = {"markup": [{"type": "rect", "color": "#00ff00", "width": 0.05, "points": [[0.25, 0.25], [0.75, 0.75]]}]}
    r = await client.put(f"/api/photos/files/{fid}/edit", json=ops, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["item"]["edited"] is True and r.json()["ops"]["markup"][0]["type"] == "rect"
    r = await client.get(f"/api/photos/files/{fid}/edited", headers=_auth(user))
    out = Image.open(io.BytesIO(r.content)).convert("RGB")
    r_, g_, b_ = out.getpixel((100, 100))  # the rectangle's top-left corner
    assert g_ > 180 and r_ < 100
    r = await client.delete(f"/api/photos/files/{fid}/edit", headers=_auth(user))
    assert r.json()["item"]["edited"] is False


@pytest.mark.asyncio
async def test_save_as_new_files_a_second_photo_beside_the_original(client, db, user, root):
    from app.files.media_meta import extract_and_store
    from app.files.models import UserFile
    from app.photos.models import PhotoAsset

    fid, path = await _real_photo(db, user, lat=-27.47, lon=153.03)
    auth = _auth(user)
    original = path.read_bytes()
    # The original has its own edit, which must stay as it is.
    kept = {"rotate": 90}
    assert (await client.put(f"/api/photos/files/{fid}/edit", json=kept, headers=_auth(user))).status_code == 200
    ops = {"crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}, "markup": [
        {"type": "text", "color": "#ffffff", "size": 0.1, "points": [[0.1, 0.1]], "text": "Look"},
        {"type": "sticker", "sticker": "star", "color": "#00ff00", "points": [[0.5, 0.5]], "size": 0.4},
    ]}
    r = await client.post(f"/api/photos/files/{fid}/save-as-new", json=ops, headers=_auth(user))
    assert r.status_code == 200, r.text
    new_id = uuid.UUID(r.json()["file_id"])
    assert r.json()["filename"] == "IMG_1234 (edited).jpg"

    orig = await db.get(UserFile, fid, populate_existing=True)
    new = await db.get(UserFile, new_id)
    folder = orig.folder_id
    assert new.folder_id == folder and new.mime_type == "image/jpeg" and new.user_id == user.id
    assert path.read_bytes() == original
    stored = await db.scalar(text("SELECT ops FROM photo_edits WHERE file_id = :f"), {"f": fid})
    assert stored["rotate"] == 90 and stored["markup"] == [] and stored["crop"] is None
    assert (await db.scalar(text("SELECT count(*) FROM photo_edits WHERE file_id = :f"), {"f": new_id})) == 0

    from app.files.storage import absolute_path

    made = Image.open(absolute_path(new.storage_path))
    assert made.size == (200, 200)
    r_, g_, b_ = made.convert("RGB").getpixel((100, 100))  # the green star on the red half
    assert g_ > 180 and r_ < 100

    # The media worker reads it: taken when (and where) the original was.
    assert await extract_and_store(new_id)
    db.expire_all()
    a_new = await db.get(PhotoAsset, new_id)
    a_old = await db.get(PhotoAsset, fid)
    assert a_new is not None and a_new.taken_at == a_old.taken_at and a_new.taken_local == a_old.taken_local
    from app.files.models import FileMedia

    m = await db.get(FileMedia, new_id)
    assert m.tz_offset == 600 and abs(m.lat - -27.47) < 1e-3 and abs(m.lon - 153.03) < 1e-3
    assert m.live_pair_file_id is None

    # A second copy gets a name of its own.
    r = await client.post(f"/api/photos/files/{fid}/save-as-new", json=ops, headers=auth)
    assert r.json()["filename"] != "IMG_1234 (edited).jpg"
    names = (await db.execute(select(UserFile.filename).where(UserFile.folder_id == folder))).scalars().all()
    assert len(names) == 3

    other = await _stranger(db)
    assert (await client.post(f"/api/photos/files/{fid}/save-as-new", json=ops, headers=_auth(other))).status_code == 404

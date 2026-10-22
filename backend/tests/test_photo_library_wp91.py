"""The photo library (WP-9.1, Part E PH-1): every photo and video you own,
by when it was taken — and what's left out."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest


@pytest.fixture
async def client(db):
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


async def _folder(db, user, name, *, parent=None, system_kind=None, hide=False):
    from app.files.models import FileFolder

    f = FileFolder(user_id=user.id, name=name, parent_id=parent.id if parent else None, system_kind=system_kind,
                   hide_from_photos=hide)
    db.add(f)
    await db.commit()
    return f


PHOTOS = object()  # "in the Photos folder" — the default


async def _photo(db, user, name, taken: datetime | None, *, offset=None, kind="image", folder=PHOTOS, mime=None,
                 live_pair=None, trashed=False):
    from app.files.models import FileMedia, UserFile
    from app.files.system_folders import ensure_camera_uploads
    from app.photos.library import sync

    if folder is PHOTOS:
        folder = await ensure_camera_uploads(db, user)
    fid = uuid.uuid4()
    mime = mime or ("video/quicktime" if kind == "video" else "image/jpeg")
    row = UserFile(id=fid, user_id=user.id, folder_id=folder.id if folder else None, filename=name, original_filename=name,
                   mime_type=mime, size_bytes=10, storage_path=f"u/{fid}",
                   trashed_at=datetime.now(timezone.utc) if trashed else None)
    db.add(row)
    await db.flush()
    db.add(FileMedia(file_id=fid, kind=kind, taken_at=taken, tz_offset=offset, width=4000, height=3000, orientation=6,
                     extracted_at=datetime.now(timezone.utc), live_pair_file_id=live_pair))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    return fid


def _utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


async def _names(client, user, **params):
    out, cursor = [], None
    while True:
        q = {**params, **({"before": cursor} if cursor else {})}
        r = (await client.get("/api/photos/timeline", params=q, headers=_auth(user))).json()
        out += [i["filename"] for i in r["items"]]
        cursor = r["next_cursor"]
        if not cursor:
            return out


@pytest.mark.asyncio
async def test_the_timeline_runs_by_when_and_where_it_was_taken(client, db, user):
    # 06:00 on 1 Jan 2024 in Brisbane is still 2023 in UTC — it's a 2024 photo.
    await _photo(db, user, "new-year.jpg", _utc(2023, 12, 31, 20, 0), offset=600)
    await _photo(db, user, "christmas.jpg", _utc(2023, 12, 25, 9, 0))
    await _photo(db, user, "beach.mov", _utc(2023, 12, 26, 9, 0), kind="video")
    await _photo(db, user, "old.jpg", _utc(2019, 5, 1, 12, 0))

    assert await _names(client, user, limit=2) == ["new-year.jpg", "beach.mov", "christmas.jpg", "old.jpg"]
    r = (await client.get("/api/photos/timeline", headers=_auth(user))).json()
    first = r["items"][0]
    assert first["taken_local"].startswith("2024-01-01T06:00") and (first["width"], first["height"]) == (3000, 4000)
    assert first["thumb"] is None and first["favorite"] is False

    b = (await client.get("/api/photos/buckets", headers=_auth(user))).json()
    assert b["buckets"] == [{"month": "2024-01", "count": 1}, {"month": "2023-12", "count": 2}, {"month": "2019-05", "count": 1}]
    assert b["total"] == 4
    # From the scrubber: start at the end of December 2023.
    assert await _names(client, user, month="2023-12") == ["beach.mov", "christmas.jpg", "old.jpg"]
    assert (await client.get("/api/photos/timeline", params={"before": "nope"}, headers=_auth(user))).status_code == 400


@pytest.mark.asyncio
async def test_what_isnt_in_the_library(client, db, user):
    """Photos is the Photos folder (like Google Photos): what's in it and
    the folders inside it — nothing elsewhere in My files."""
    from app.auth.models import User
    from app.files.system_folders import ensure_camera_uploads

    when = _utc(2025, 3, 3)
    photos = await ensure_camera_uploads(db, user)
    await db.commit()
    await _photo(db, user, "kept.jpg", when)
    month = await _folder(db, user, "2025", parent=photos)
    await _photo(db, user, "in-a-month.jpg", when, folder=month)

    await _photo(db, user, "loose.jpg", when, folder=None)  # the top of My files
    docs = await _folder(db, user, "Important Documents")
    await _photo(db, user, "id-card.jpg", when, folder=docs)
    gen = await _folder(db, user, "Generated Files", system_kind="generated_root")
    await _photo(db, user, "generated.png", when, folder=gen, mime="image/png")
    chat = await _folder(db, user, "Chat Uploads", system_kind="chat_uploads")
    await _photo(db, user, "chat.jpg", when, folder=chat)
    ws_root = await _folder(db, user, "Workspaces", system_kind="workspaces_root")
    ws = await _folder(db, user, "Team", parent=ws_root)
    await _photo(db, user, "workspace.jpg", when, folder=ws)
    hidden = await _folder(db, user, "Scans", parent=photos, hide=True)
    inner = await _folder(db, user, "2020", parent=hidden)
    await _photo(db, user, "scan.jpg", when, folder=inner)
    await _photo(db, user, "binned.jpg", when, trashed=True)
    still = await _photo(db, user, "live.heic", when, mime="image/heic")
    mov = await _photo(db, user, "live.mov", when, kind="video", live_pair=still)
    from app.files.models import FileMedia

    (await db.get(FileMedia, still)).live_pair_file_id = mov  # paired both ways, as the worker does
    await db.commit()

    other = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    await _photo(db, other, "someone-elses.jpg", when)

    names = set(await _names(client, user))
    assert names == {"kept.jpg", "in-a-month.jpg", "live.heic"}
    items = (await client.get("/api/photos/timeline", headers=_auth(user))).json()["items"]
    assert next(i for i in items if i["filename"] == "live.heic")["live"] is True

    # Un-hiding the folder brings its photos back — nothing to rebuild.
    r = await client.patch(f"/api/files/folders/{hidden.id}", json={"hide_from_photos": False}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["hide_from_photos"] is False
    assert "scan.jpg" in await _names(client, user)


@pytest.mark.asyncio
async def test_archive_and_favourites(client, db, user):
    a = await _photo(db, user, "a.jpg", _utc(2025, 1, 1))
    b = await _photo(db, user, "b.jpg", _utc(2025, 1, 2))
    r = await client.post("/api/photos/archive", json={"file_ids": [str(a)], "archived": True}, headers=_auth(user))
    assert r.json() == {"updated": 1}
    assert await _names(client, user) == ["b.jpg"]
    assert await _names(client, user, view="archive") == ["a.jpg"]
    # Favourites are the Drive star — photos are files.
    assert (await client.post(f"/api/files/{b}/star", headers=_auth(user))).status_code == 200
    assert await _names(client, user, view="favorites") == ["b.jpg"]
    await client.post("/api/photos/archive", json={"file_ids": [str(a)], "archived": False}, headers=_auth(user))
    assert await _names(client, user) == ["b.jpg", "a.jpg"]


@pytest.mark.asyncio
async def test_correcting_a_date_moves_the_photo(client, db, user):
    fid = await _photo(db, user, "scan.jpg", _utc(2025, 6, 1))
    await _photo(db, user, "recent.jpg", _utc(2025, 5, 1))
    r = await client.patch(f"/api/files/{fid}/media", json={"taken_at": "1998-08-08T12:00:00Z"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert await _names(client, user) == ["recent.jpg", "scan.jpg"]
    b = (await client.get("/api/photos/buckets", headers=_auth(user))).json()["buckets"]
    assert {"month": "1998-08", "count": 1} in b


@pytest.mark.asyncio
async def test_reading_a_file_puts_it_in_the_library(db, user, tmp_path, monkeypatch):
    """The media worker's metadata pass adds it (and a later trash leaves it out)."""
    from app.files import media_meta, storage
    from app.files.models import UserFile
    from app.photos.models import PhotoAsset

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(media_meta, "read_tags", lambda _p: {"EXIF:DateTimeOriginal": "2022:02:02 10:00:00"})
    fid = uuid.uuid4()
    (tmp_path / "x.jpg").write_bytes(b"\xff\xd8\xff\xd9")
    db.add(UserFile(id=fid, user_id=user.id, filename="x.jpg", original_filename="x.jpg", mime_type="image/jpeg",
                    size_bytes=4, storage_path="x.jpg"))
    await db.commit()
    assert await media_meta.extract_and_store(fid) is True
    asset = await db.get(PhotoAsset, fid, populate_existing=True)
    assert asset is not None and asset.taken_local == datetime(2022, 2, 2, 10, 0) - timedelta(0)

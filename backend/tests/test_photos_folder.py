"""The Photos folder (like Google Photos): one locked folder in My files is
the photo library. Pictures elsewhere are ordinary files until "Move to
Photos" files them in; a phone app still pointed at the old "Camera
Uploads" keeps backing up into it."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_photo_library_wp91 import _auth, _folder, _names, _photo, _utc, client  # noqa: F401
from tests.test_webdav_wp84 import _device, quiet, root  # noqa: F401


@pytest.mark.asyncio
async def test_settings_name_the_photos_folder_and_make_it_if_missing(client, db, user):
    from app.files.models import FileFolder

    s = (await client.get("/api/photos/settings", headers=_auth(user))).json()
    folder = await db.get(FileFolder, uuid.UUID(s["folder"]["id"]))
    assert s["folder"]["name"] == "Photos" and folder.system_kind == "camera_uploads" and folder.parent_id is None
    # Locked: it can't be renamed or deleted.
    r = await client.patch(f"/api/files/folders/{folder.id}", json={"name": "Pics"}, headers=_auth(user))
    assert r.status_code in (400, 403)
    assert (await client.delete(f"/api/files/folders/{folder.id}", headers=_auth(user))).status_code in (400, 403)


@pytest.mark.asyncio
async def test_a_folder_of_yours_called_photos_becomes_it(db, user):
    from app.files.system_folders import ensure_camera_uploads

    mine = await _folder(db, user, "Photos")
    got = await ensure_camera_uploads(db, user)
    assert got.id == mine.id and got.system_kind == "camera_uploads"


@pytest.mark.asyncio
async def test_new_accounts_get_a_photos_folder(db, user):
    from app.files.models import FileFolder
    from app.files.system_folders import seed_system_folders

    await seed_system_folders(db, user)
    await db.commit()
    names = (
        await db.execute(select(FileFolder.name).where(FileFolder.user_id == user.id, FileFolder.system_kind == "camera_uploads"))
    ).scalars().all()
    assert names == ["Photos"]


@pytest.mark.asyncio
async def test_move_to_photos_files_a_picture_in_by_its_month(client, db, user):
    from app.auth.models import User
    from app.files.models import FileFolder, UserFile

    docs = await _folder(db, user, "Important Documents")
    card = await _photo(db, user, "card.jpg", _utc(2026, 7, 29, 3), folder=docs)
    assert await _names(client, user) == []  # not in Photos

    r = await client.post(f"/api/photos/files/{card}/move-to-photos", headers=_auth(user))
    assert r.status_code == 200 and r.json()["moved"] is True
    assert await _names(client, user) == ["card.jpg"]
    row = await db.get(UserFile, card, populate_existing=True)
    month = await db.get(FileFolder, row.folder_id)
    year = await db.get(FileFolder, month.parent_id)
    assert (year.name, month.name) == ("2026", "07")
    again = await client.post(f"/api/photos/files/{card}/move-to-photos", headers=_auth(user))
    assert again.json()["moved"] is False

    # Only your own pictures and videos.
    other = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    theirs = await _photo(db, other, "theirs.jpg", _utc(2026, 7, 1), folder=None)
    assert (await client.post(f"/api/photos/files/{theirs}/move-to-photos", headers=_auth(user))).status_code == 404
    note = await _photo(db, user, "notes.jpg", _utc(2026, 7, 1), folder=None)
    from app.files.models import FileMedia

    await db.delete(await db.get(FileMedia, note))  # not a photo: no media row
    await db.commit()
    assert (await client.post(f"/api/photos/files/{note}/move-to-photos", headers=_auth(user))).status_code == 400


@pytest.mark.asyncio
async def test_a_phone_still_pointed_at_camera_uploads_backs_up_into_photos(client, db, user):
    from app.files.models import FileFolder, UserFile
    from app.files.system_folders import ensure_camera_uploads

    photos = await ensure_camera_uploads(db, user)
    await db.commit()
    _row, auth = await _device(db, user)
    r = await client.request("PUT", "/dav/Camera Uploads/backup.txt", headers=auth, content=b"from the phone")
    assert r.status_code == 201, r.text
    f = (await db.execute(select(UserFile).where(UserFile.user_id == user.id, UserFile.filename == "backup.txt"))).scalars().one()
    assert f.folder_id == photos.id
    # Its listing shows the Photos folder by its name.
    names = (await db.execute(select(FileFolder.name).where(FileFolder.id == photos.id))).scalars().all()
    assert names == ["Photos"]

"""Camera Uploads (WP-8.5): phone backups and shared photos land in
Camera Uploads/YYYY/MM by when they were taken, and the same photo twice is
one file. Plus the WebDAV side of a phone backup."""
from __future__ import annotations

import base64
import io
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import func, select


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    from app.tasks import queue

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(queue, "enqueue_office_text", nothing)


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


def _jpeg(taken: str | None, colour=(200, 80, 40)) -> bytes:
    from PIL import Image

    img = Image.new("RGB", (16, 16), colour)
    exif = img.getexif()
    if taken:
        exif.get_ifd(0x8769)[36867] = taken  # DateTimeOriginal
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


async def _upload(client, user, name, data, **form):
    r = await client.post(
        "/api/files/", headers=_auth(user), files={"file": (name, data, "image/jpeg")},
        data={"scope": "mine", **{k: str(v) for k, v in form.items()}},
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _path(db, folder_id) -> list[str]:
    from app.files.models import FileFolder

    names = []
    while folder_id is not None:
        f = await db.get(FileFolder, uuid.UUID(str(folder_id)))
        names.append(f.name)
        folder_id = f.parent_id
    return names[::-1]


@pytest.mark.asyncio
async def test_photos_are_filed_by_when_they_were_taken_and_kept_once(client, db, user):
    from app.files.models import UserFile

    photo = _jpeg("2021:07:04 10:00:00")
    first = await _upload(client, user, "IMG_0001.jpg", photo, route="camera")
    assert await _path(db, first["folder_id"]) == ["Camera Uploads", "2021", "07"]

    # The same photo again — another device, a reinstall: the one file.
    again = await _upload(client, user, "IMG_0001 (1).jpg", photo, route="camera")
    assert again["id"] == first["id"]
    count = await db.scalar(select(func.count(UserFile.id)).where(UserFile.user_id == user.id))
    assert count == 1

    # No date in it: the device's modified time decides the month.
    plain = await _upload(client, user, "scan.jpg", _jpeg(None, (1, 2, 3)), route="camera",
                          last_modified=int(datetime(2019, 2, 3, tzinfo=timezone.utc).timestamp() * 1000))
    assert await _path(db, plain["folder_id"]) == ["Camera Uploads", "2019", "02"]


@pytest.mark.asyncio
async def test_uploading_into_camera_uploads_itself_sorts_too(client, db, user):
    from app.files.system_folders import ensure_camera_uploads

    cam = await ensure_camera_uploads(db, user)
    await db.commit()
    out = await _upload(client, user, "IMG_0002.jpg", _jpeg("2024:12:31 23:30:00"), folder_id=cam.id)
    assert await _path(db, out["folder_id"]) == ["Camera Uploads", "2024", "12"]


@pytest.mark.asyncio
async def test_a_folder_you_already_called_camera_uploads_becomes_it(db, user):
    from app.files.models import FileFolder
    from app.files.system_folders import SystemKind, ensure_camera_uploads

    mine = FileFolder(user_id=user.id, name="camera uploads")
    db.add(mine)
    await db.commit()
    cam = await ensure_camera_uploads(db, user)
    assert cam.id == mine.id and cam.system_kind == SystemKind.CAMERA_UPLOADS.value
    assert (await ensure_camera_uploads(db, user)).id == mine.id


async def _device(db, user):
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    token = new_token()
    db.add(AppPassword(user_id=user.id, name="Sam's iPhone", token_hash=token_hash(token), hint=hint(token),
                       scopes=["dav:read", "dav:write"]))
    await db.commit()
    return {"Authorization": "Basic " + base64.b64encode(f"{user.username}:{token}".encode()).decode()}


@pytest.mark.asyncio
async def test_a_phone_backing_up_over_webdav(client, db, user):
    from app.files import dav
    from app.files.models import FileVersion, UserFile

    dav.locks.clear()
    auth = await _device(db, user)
    # A device's first look finds Camera Uploads to point the phone at.
    r = await client.request("PROPFIND", "/dav/", headers={**auth, "Depth": "1"})
    assert "/dav/Camera%20Uploads/" in r.text

    # PhotoSync makes its own YYYY/MM folders and keeps the exact path.
    for p in ("/dav/Camera%20Uploads/2026", "/dav/Camera%20Uploads/2026/10"):
        assert (await client.request("MKCOL", p, headers=auth)).status_code == 201
    photo = _jpeg("2026:10:01 08:00:00")
    url = "/dav/Camera%20Uploads/2026/10/IMG_0100.jpg"
    r = await client.put(url, headers={**auth, "X-OC-Mtime": "1759305600"}, content=photo)
    assert r.status_code == 201
    row = (await db.execute(select(UserFile).where(UserFile.filename == "IMG_0100.jpg"))).scalars().one()
    assert await _path(db, row.folder_id) == ["Camera Uploads", "2026", "10"]

    # Sent again after a reinstall: nothing stored, no version.
    r = await client.put(url, headers=auth, content=photo)
    assert r.status_code == 204
    assert (await db.execute(select(FileVersion).where(FileVersion.file_id == row.id))).scalars().all() == []


@pytest.mark.asyncio
async def test_a_new_device_finds_camera_uploads_ready(client, db, user):
    from app.files.models import FileFolder

    r = await client.post("/api/auth/app-passwords", json={"name": "Pixel", "scopes": ["dav:read", "dav:write"]},
                          headers=_auth(user))
    assert r.status_code == 201
    names = (await db.execute(select(FileFolder.system_kind).where(FileFolder.user_id == user.id))).scalars().all()
    assert "camera_uploads" in names


@pytest.mark.asyncio
async def test_a_device_that_deletes_everything_is_named_in_the_alert(db, user, monkeypatch):
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash
    from app.auth.credential import set_credential
    from app.files import mass_delete
    from app.files.models import UserFile

    dev = AppPassword(user_id=user.id, name="Old laptop", token_hash=token_hash(t := new_token()), hint=hint(t),
                      scopes=["dav:write"])
    db.add(dev)
    await db.commit()
    set_credential(f"app_password:{dev.id}")
    monkeypatch.setattr(mass_delete, "MAX_FILES", 2)
    for i in range(3):
        row = UserFile(user_id=user.id, filename=f"f{i}.txt", original_filename=f"f{i}.txt", mime_type="text/plain",
                       size_bytes=1, storage_path=f"x/{i}", trashed_at=datetime.now(timezone.utc))
        mass_delete.apply(row, user)
        db.add(row)
    await db.commit()

    sent = []

    async def notify_user(**kw):
        sent.append(kw)

    import app.notifications.dispatch as dispatch

    monkeypatch.setattr(dispatch, "notify_user", notify_user)

    async def first(*_a):
        return True

    monkeypatch.setattr(mass_delete, "_first_this_hour", first)
    try:
        assert await mass_delete.check(db, user) is True
    finally:
        set_credential(None)
    assert "“Old laptop”" in sent[0]["body"] and "Account → Devices" in sent[0]["body"]
    assert sent[0]["url"] == f"/files/trash?restore=app_password:{dev.id}"

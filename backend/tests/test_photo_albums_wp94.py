"""Albums (WP-9.4, Part E PH-1): references to photos, shared with viewers
and contributors — and the access that comes with being in one."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import httpx
import pytest

from tests.test_understanding_ph21 import _photos_folder  # photos live in the Photos folder


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


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    import app.notifications.dispatch as dispatch

    sent = []

    async def notify_user(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", notify_user)
    return sent


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _person(db, name):
    from app.auth.models import User

    u = User(email=f"{name}{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _photo(db, user, name, day):
    from app.files.models import FileMedia, UserFile
    from app.photos.library import sync

    fid = uuid.uuid4()
    db.add(UserFile(id=fid, user_id=user.id, folder_id=(await _photos_folder(db, user)).id, filename=name, original_filename=name, mime_type="image/jpeg",
                    size_bytes=1, storage_path=f"u/{fid}"))
    await db.flush()
    db.add(FileMedia(file_id=fid, kind="image", taken_at=datetime(2026, 7, day, tzinfo=timezone.utc),
                     extracted_at=datetime.now(timezone.utc)))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    return str(fid)


async def _names(client, user, album_id):
    r = await client.get(f"/api/photos/albums/{album_id}/items", headers=_auth(user))
    assert r.status_code == 200, r.text
    return [i["filename"] for i in r.json()["items"]]


@pytest.mark.asyncio
async def test_an_album_shared_with_family(client, db, user, quiet):
    mum = await _person(db, "mum")
    gran = await _person(db, "gran")
    a = await _photo(db, user, "beach.jpg", 3)
    b = await _photo(db, user, "sunset.jpg", 5)
    mums = await _photo(db, mum, "mums-picnic.jpg", 4)

    # Only your own photos go in: mum's is skipped.
    r = await client.post("/api/photos/albums", json={"title": "Holiday 2026", "file_ids": [a, b, mums]}, headers=_auth(user))
    assert r.status_code == 201
    album = r.json()
    assert album["count"] == 2 and album["role"] == "owner" and album["cover"]["filename"] == "sunset.jpg"
    aid = album["id"]

    # Mum can add hers; Gran can only look.
    assert (await client.post(f"/api/photos/albums/{aid}/members", json={"user_id": str(mum.id), "role": "contributor"}, headers=_auth(user))).status_code == 201
    assert (await client.post(f"/api/photos/albums/{aid}/members", json={"user_id": str(gran.id)}, headers=_auth(user))).status_code == 201
    assert {n["user_id"] for n in quiet} == {mum.id, gran.id}
    assert (await client.post(f"/api/photos/albums/{aid}/items", json={"file_ids": [mums]}, headers=_auth(mum))).json() == {"added": 1}
    # ...not the owner's photos onto her account, nor anything as a viewer.
    assert (await client.post(f"/api/photos/albums/{aid}/items", json={"file_ids": [a]}, headers=_auth(mum))).json() == {"added": 0}
    assert (await client.post(f"/api/photos/albums/{aid}/items", json={"file_ids": [a]}, headers=_auth(gran))).status_code == 403
    assert (await client.patch(f"/api/photos/albums/{aid}", json={"title": "x"}, headers=_auth(gran))).status_code == 403

    assert await _names(client, gran, aid) == ["sunset.jpg", "mums-picnic.jpg", "beach.jpg"]
    listed = (await client.get("/api/photos/albums", headers=_auth(gran))).json()["albums"]
    assert [(x["title"], x["role"], x["count"]) for x in listed] == [("Holiday 2026", "viewer", 3)]

    # Being in the album lets Gran open the photos (signed links, previews)…
    assert (await client.get(f"/api/files/{a}/signed-urls", headers=_auth(gran))).status_code == 200
    stranger = await _person(db, "stranger")
    assert (await client.get(f"/api/files/{a}/signed-urls", headers=_auth(stranger))).status_code == 404
    assert (await client.get(f"/api/photos/albums/{aid}", headers=_auth(stranger))).status_code == 404

    # A contributor takes out only what she put in.
    r = await client.request("DELETE", f"/api/photos/albums/{aid}/items", json={"file_ids": [a, mums]}, headers=_auth(mum))
    assert r.json() == {"removed": 1}
    await client.post(f"/api/photos/albums/{aid}/items", json={"file_ids": [mums]}, headers=_auth(mum))

    # Leaving takes her photos with her; removing Gran ends her access.
    assert (await client.delete(f"/api/photos/albums/{aid}/members/{mum.id}", headers=_auth(mum))).status_code == 204
    assert await _names(client, user, aid) == ["sunset.jpg", "beach.jpg"]
    assert (await client.delete(f"/api/photos/albums/{aid}/members/{gran.id}", headers=_auth(user))).status_code == 204
    assert (await client.get(f"/api/files/{a}/signed-urls", headers=_auth(gran))).status_code == 404


@pytest.mark.asyncio
async def test_the_owner_arranges_and_deletes_it(client, db, user):
    a = await _photo(db, user, "first.jpg", 1)
    b = await _photo(db, user, "second.jpg", 9)
    other = await _photo(db, user, "elsewhere.jpg", 2)
    aid = (await client.post("/api/photos/albums", json={"title": "Trip", "file_ids": [a, b]}, headers=_auth(user))).json()["id"]

    r = await client.patch(f"/api/photos/albums/{aid}", json={"sort": "oldest", "cover_file_id": a, "description": "Road trip"}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["cover"]["filename"] == "first.jpg"
    assert await _names(client, user, aid) == ["first.jpg", "second.jpg"]
    assert (await client.patch(f"/api/photos/albums/{aid}", json={"cover_file_id": other}, headers=_auth(user))).status_code == 422

    # A photo in the trash isn't shown; deleting the album keeps the photos.
    from app.files.models import UserFile

    row = await db.get(UserFile, uuid.UUID(b))
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    assert await _names(client, user, aid) == ["first.jpg"]
    assert (await client.delete(f"/api/photos/albums/{aid}", headers=_auth(user))).status_code == 204
    assert await db.get(UserFile, uuid.UUID(a)) is not None
    assert (await client.get(f"/api/photos/albums/{aid}", headers=_auth(user))).status_code == 404


async def _upload(db, user, name, mime="image/jpeg", folder=True):
    """A file as it is straight after an upload: saved, not yet read by the media worker."""
    from app.files.models import UserFile

    fid = uuid.uuid4()
    db.add(UserFile(id=fid, user_id=user.id, folder_id=(await _photos_folder(db, user)).id if folder else None, filename=name,
                    original_filename=name, mime_type=mime, size_bytes=1, storage_path=f"u/{fid}"))
    await db.commit()
    return str(fid)


async def _read_by_the_worker(db, fid):
    from app.files.models import FileMedia
    from app.photos.library import sync

    db.add(FileMedia(file_id=uuid.UUID(fid), kind="image", taken_at=datetime(2026, 7, 9, tzinfo=timezone.utc),
                     extracted_at=datetime.now(timezone.utc)))
    await db.flush()
    await sync(db, uuid.UUID(fid))
    await db.commit()


@pytest.mark.asyncio
async def test_an_album_keeps_photos_the_worker_has_not_read_yet(client, db, user):
    """Made straight after an upload, an album used to come out short with
    no word of it: photos not yet in the library were dropped."""
    ready = await _photo(db, user, "ready.jpg", 1)
    fresh = await _upload(db, user, "fresh.jpg")
    later = await _upload(db, user, "later.jpg")
    notes = await _upload(db, user, "notes.pdf", mime="application/pdf")

    r = await client.post("/api/photos/albums", json={"title": "Trip", "file_ids": [ready, fresh, notes]}, headers=_auth(user))
    assert r.status_code == 201, r.text
    album = r.json()
    assert album["added"] == 2  # both photos; the PDF is not one
    assert album["count"] == 1  # what can be seen so far
    assert await _names(client, user, album["id"]) == ["ready.jpg"]

    r = await client.post(f"/api/photos/albums/{album['id']}/items", json={"file_ids": [later, fresh]}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["added"] == 1, r.text  # fresh was already in

    for fid in (fresh, later):
        await _read_by_the_worker(db, fid)
    assert sorted(await _names(client, user, album["id"])) == ["fresh.jpg", "later.jpg", "ready.jpg"]
    r = await client.get("/api/photos/albums", headers=_auth(user))
    assert [a["count"] for a in r.json()["albums"] if a["id"] == album["id"]] == [3]


@pytest.mark.asyncio
async def test_someone_elses_unread_upload_is_not_taken(client, db, user):
    other = await _person(db, "pat")
    theirs = await _upload(db, other, "theirs.jpg")
    r = await client.post("/api/photos/albums", json={"title": "Mine", "file_ids": [theirs]}, headers=_auth(user))
    assert r.status_code == 201 and r.json()["added"] == 0, r.text

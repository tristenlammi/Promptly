"""Scale (WP-7.6, Part C §5.9): listings a page at a time (keyset), a
folders-only listing for the tree and the Move picker, and zip downloads
written as a background job with their folder structure kept."""
from __future__ import annotations

import io
import time
import uuid
import zipfile
from datetime import datetime, timezone

import httpx
import pytest


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture(autouse=True)
def quiet_queues(monkeypatch):
    from app.files import zip_jobs
    from app.tasks import queue

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(zip_jobs, "start", nothing)  # the test builds it itself


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


async def _person(db, name):
    from app.auth.models import User

    row = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
               password_hash="x", role="user")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _folder(client, user, name, parent=None):
    r = await client.post("/api/files/folders", json={"name": name, "scope": "mine", "parent_id": parent}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _upload(client, user, name, data=b"hello", mime="text/plain", folder=None):
    form = {"scope": "mine"}
    if folder:
        form["folder_id"] = folder
    r = await client.post("/api/files/", files={"file": (name, data, mime)}, data=form, headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _all_pages(client, user, path, limit):
    ids, folders, cursor, pages = [], [], None, 0
    while True:
        sep = "&" if "?" in path else "?"
        url = f"{path}{sep}limit={limit}" + (f"&cursor={cursor}" if cursor else "")
        r = await client.get(url, headers=_auth(user))
        assert r.status_code == 200, r.text
        body = r.json()
        ids += [f["id"] for f in body["files"]]
        folders += [f["id"] for f in body["folders"]]
        pages += 1
        if pages > 1:
            assert body["folders"] == []  # folders come on the first page only
        cursor = body.get("next_cursor")
        if not cursor:
            return ids, folders, pages


# ---------------------------------------------------------------- pages


@pytest.mark.asyncio
async def test_a_folder_comes_a_page_at_a_time_in_order_without_gaps(client, db, user):
    top = await _folder(client, user, "Camera roll")
    await _folder(client, user, "Sub", top)
    # Equal names, so only the id keeps the order stable between pages.
    made = [await _upload(client, user, "IMG.txt" if i % 3 == 0 else f"IMG_{i:03d}.txt", b"x" * (i + 1), folder=top) for i in range(23)]

    # Half of them share one modified time, so only the id orders them.
    from sqlalchemy import update

    from app.files.models import UserFile

    same = made[::2]
    await db.execute(
        update(UserFile).where(UserFile.id.in_([uuid.UUID(x) for x in same])).values(modified_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
    )
    await db.commit()

    whole = (await client.get(f"/api/files/browse?scope=mine&folder_id={top}", headers=_auth(user))).json()
    assert whole["next_cursor"] is None and len(whole["files"]) == 23  # no limit: everything, as before

    for sort in ("name", "modified", "size"):
        for d in ("asc", "desc"):
            ids, folders, pages = await _all_pages(client, user, f"/api/files/browse?scope=mine&folder_id={top}&sort={sort}&dir={d}", 10)
            assert pages == 3 and len(folders) == 1
            assert sorted(ids) == sorted(made) and len(set(ids)) == 23, (sort, d)
            full = (await client.get(f"/api/files/browse?scope=mine&folder_id={top}&sort={sort}&dir={d}", headers=_auth(user))).json()
            assert ids == [f["id"] for f in full["files"]], (sort, d)

    # A cursor belongs to its sort.
    first = (await client.get(f"/api/files/browse?scope=mine&folder_id={top}&limit=5", headers=_auth(user))).json()
    r = await client.get(f"/api/files/browse?scope=mine&folder_id={top}&limit=5&sort=size&cursor={first['next_cursor']}", headers=_auth(user))
    assert r.status_code == 400
    assert (await client.get(f"/api/files/browse?scope=mine&limit=5&cursor=garbage", headers=_auth(user))).status_code == 400


@pytest.mark.asyncio
async def test_shared_listings_page_too(client, db, user):
    pal = await _person(db, "pal")
    top = await _folder(client, user, "For pal")
    for i in range(7):
        await _upload(client, user, f"doc{i}.txt", folder=top)
    loose = [await _upload(client, user, f"loose{i}.txt") for i in range(5)]
    for kind, rid in [("folder", top), *[("file", x) for x in loose]]:
        r = await client.post(f"/api/files/{kind}/{rid}/grants", json={"grantee_user_id": str(pal.id)}, headers=_auth(user))
        assert r.status_code in (200, 201), r.text

    ids, folders, pages = await _all_pages(client, pal, "/api/files/browse?scope=shared&shared=with_me", 2)
    assert sorted(ids) == sorted(loose) and folders == [top] and pages == 3
    inside, _f, pages = await _all_pages(client, pal, f"/api/files/browse?scope=shared&folder_id={top}", 3)
    assert len(inside) == 7 and len(set(inside)) == 7 and pages == 3


@pytest.mark.asyncio
async def test_the_tree_gets_folders_only(client, db, user):
    top = await _folder(client, user, "Projects")
    await _folder(client, user, "Alpha", top)
    await _folder(client, user, "Beta", top)
    await _upload(client, user, "big.txt", folder=top)
    body = (await client.get(f"/api/files/folders?scope=mine&parent_id={top}", headers=_auth(user))).json()
    assert [f["name"] for f in body["folders"]] == ["Alpha", "Beta"] and body["files"] == []
    root_body = (await client.get("/api/files/folders?scope=mine", headers=_auth(user))).json()
    assert top in [f["id"] for f in root_body["folders"]]


@pytest.mark.asyncio
async def test_trash_and_starred_page(client, db, user):
    ids = [await _upload(client, user, f"t{i}.txt") for i in range(6)]
    for fid in ids[:5]:
        assert (await client.post(f"/api/files/{fid}/star", headers=_auth(user))).status_code == 200
    got, _f, pages = await _all_pages(client, user, "/api/files/starred?scope=mine", 2)
    assert sorted(got) == sorted(ids[:5]) and pages == 3
    for fid in ids:
        assert (await client.post(f"/api/files/{fid}/trash", headers=_auth(user))).status_code == 200
    got, _f, pages = await _all_pages(client, user, "/api/files/trash?scope=mine", 4)
    assert sorted(got) == sorted(ids) and pages == 2


# ---------------------------------------------------------------- zips


async def _zip(client, user, file_ids=(), folder_ids=()):
    from app.files import zip_jobs

    r = await client.post("/api/files/bulk/zip", json={"file_ids": list(file_ids), "folder_ids": list(folder_ids)}, headers=_auth(user))
    assert r.status_code == 202, r.text
    job = r.json()
    assert await zip_jobs.build(job["job_id"]) == "ready"
    status = (await client.get(f"/api/files/zips/{job['job_id']}", headers=_auth(user))).json()
    assert status["state"] == "ready" and status["url"].startswith("/m/")
    return job, status


@pytest.mark.asyncio
async def test_a_folder_zips_with_its_whole_structure(client, db, user):
    top = await _folder(client, user, "Trip")
    day1 = await _folder(client, user, "Day 1", top)
    deep = await _folder(client, user, "Beach", day1)
    await _folder(client, user, "Empty", top)
    await _upload(client, user, "notes.txt", b"plan " * 400, folder=top)
    await _upload(client, user, "photo.jpg", b"\xff\xd8\xff\xe0" + b"j" * 3000, mime="image/jpeg", folder=deep)
    await _upload(client, user, "notes.txt", b"day one", folder=day1)

    job, status = await _zip(client, user, folder_ids=[top])
    assert job["name"] == "Trip.zip" and status["files"] == 3
    r = await client.get("/api" + status["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert 'filename="Trip.zip"' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    # Nested folders kept (they used to be flattened into "Trip/"), and the
    # empty one too.
    assert {"Trip/notes.txt", "Trip/Day 1/notes.txt", "Trip/Day 1/Beach/photo.jpg", "Trip/Empty/"} <= names
    assert z.read("Trip/Day 1/notes.txt") == b"day one"
    assert z.getinfo("Trip/Day 1/Beach/photo.jpg").compress_type == zipfile.ZIP_STORED
    assert z.getinfo("Trip/notes.txt").compress_type == zipfile.ZIP_DEFLATED

    # Behind nginx: served from the read-only mount.
    accel = await client.get("/api" + status["url"], headers={"X-Promptly-Accel": "1"})
    assert accel.headers["x-accel-redirect"] == f"/_renditions/zips/{job['job_id']}.zip"


@pytest.mark.asyncio
async def test_shared_files_you_can_only_read_are_zipped_and_nobody_else_gets_your_zip(client, db, user):
    pal = await _person(db, "pal")
    stranger = await _person(db, "stranger")
    top = await _folder(client, user, "Recipes")
    await _upload(client, user, "soup.txt", b"soup", folder=top)
    await client.post(f"/api/files/folder/{top}/grants", json={"grantee_user_id": str(pal.id)}, headers=_auth(user))

    job, status = await _zip(client, pal, folder_ids=[top])
    assert status["files"] == 1  # read access is enough (it used to need write)
    assert (await client.get(f"/api/files/zips/{job['job_id']}", headers=_auth(stranger))).status_code == 404
    # The link is pal's: a forged one for the stranger doesn't verify, and
    # pal's own stops once they sign out everywhere.
    from app.auth.models import User

    me = await db.get(User, pal.id)
    me.token_version += 1
    await db.commit()
    assert (await client.get("/api" + status["url"])).status_code == 404


@pytest.mark.asyncio
async def test_zip_limits_and_cleanup(client, db, user, monkeypatch):
    from app.files import zip_jobs

    ids = [await _upload(client, user, f"f{i}.txt") for i in range(3)]
    monkeypatch.setattr(zip_jobs, "MAX_FILES", 2)
    r = await client.post("/api/files/bulk/zip", json={"file_ids": ids, "folder_ids": []}, headers=_auth(user))
    assert r.status_code == 413
    monkeypatch.setattr(zip_jobs, "MAX_FILES", 10_000)
    nothing = await client.post("/api/files/bulk/zip", json={"file_ids": [str(uuid.uuid4())], "folder_ids": []}, headers=_auth(user))
    assert nothing.status_code == 400

    job, _status = await _zip(client, user, file_ids=ids)
    path = zip_jobs.zip_path(job["job_id"])
    assert path.is_file()
    assert zip_jobs.sweep(max_age=3600) == 0
    old = time.time() - 7200
    import os

    os.utime(path, (old, old))
    assert zip_jobs.sweep(max_age=3600) == 1 and not path.exists()

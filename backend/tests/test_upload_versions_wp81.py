"""Versions for every uploaded file (WP-8.1, Part C §5.8): Replace keeps the
file and its old bytes as a version; AI re-renders keep what they replace;
versions can be compared, downloaded and restored; retention is 30 days,
then the newest 100."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select


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


async def _person(db, name):
    from app.auth.models import User

    row = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
               password_hash="x", role="user")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _upload(client, user, name, data, conflict="allow", mime="text/plain"):
    r = await client.post(
        "/api/files/", files={"file": (name, data, mime)}, data={"scope": "mine", "on_conflict": conflict}, headers=_auth(user)
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _bytes(client, user, fid):
    urls = (await client.get(f"/api/files/{fid}/signed-urls", headers=_auth(user))).json()
    return (await client.get("/api" + urls["original"])).content


@pytest.mark.asyncio
async def test_replace_keeps_the_file_and_its_old_bytes_as_a_version(client, db, user):
    first = await _upload(client, user, "notes.txt", b"line one\nline two\n")
    fid = first["id"]
    assert (await client.post(f"/api/files/{fid}/star", headers=_auth(user))).status_code == 200

    second = await _upload(client, user, "notes.txt", b"line one\nline 2\nline three\n", conflict="replace")
    # The same file: same id, still starred, not a new row with the old in the trash.
    assert second["id"] == fid and second["starred_at"]
    assert await _bytes(client, user, fid) == b"line one\nline 2\nline three\n"
    trash = (await client.get("/api/files/trash", headers=_auth(user))).json()
    assert trash["files"] == []

    hist = (await client.get(f"/api/files/{fid}/versions", headers=_auth(user))).json()
    assert hist["kind"] == "blob" and hist["can_edit"] is True
    [v] = hist["versions"]
    assert v["source"] == "upload" and v["size_bytes"] == len(b"line one\nline two\n")

    # The old bytes, by link, named for when they were.
    old = await client.get("/api" + v["download_url"])
    assert old.status_code == 200 and old.content == b"line one\nline two\n"
    assert 'filename="notes (' in old.headers["content-disposition"]

    # What restoring would change, line by line.
    diff = (await client.get(f"/api/files/{fid}/versions/{v['id']}/diff", headers=_auth(user))).json()
    assert diff["kind"] == "blob" and diff["removed"] >= 1 and diff["added"] >= 1

    r = await client.post(f"/api/files/{fid}/versions/{v['id']}/restore", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert await _bytes(client, user, fid) == b"line one\nline two\n"
    hist = (await client.get(f"/api/files/{fid}/versions", headers=_auth(user))).json()
    assert [x["source"] for x in hist["versions"]] == ["restore", "upload"]
    assert hist["versions"][0]["label"].startswith("Before restoring")


@pytest.mark.asyncio
async def test_people_it_is_shared_with_see_history_but_only_editors_restore(client, db, user):
    pal = await _person(db, "pal")
    f = await _upload(client, user, "plan.txt", b"v1")
    await _upload(client, user, "plan.txt", b"v2", conflict="replace")
    await client.post(f"/api/files/file/{f['id']}/grants", json={"grantee_user_id": str(pal.id)}, headers=_auth(user))
    hist = (await client.get(f"/api/files/{f['id']}/versions", headers=_auth(pal))).json()
    assert hist["can_edit"] is False and len(hist["versions"]) == 1
    v = hist["versions"][0]
    assert (await client.get("/api" + v["download_url"])).content == b"v1"
    r = await client.post(f"/api/files/{f['id']}/versions/{v['id']}/restore", headers=_auth(pal))
    assert r.status_code == 403
    stranger = await _person(db, "stranger")
    assert (await client.get(f"/api/files/{f['id']}/versions", headers=_auth(stranger))).status_code == 404


@pytest.mark.asyncio
async def test_an_ai_rerender_keeps_what_it_replaces(client, db, user, root):
    from app.files.generated import overwrite_generated_file, persist_generated_file
    from app.files.models import FileVersion

    row = await persist_generated_file(db, user=user, content=b"# Draft\n", filename="brief.md", mime_type="text/markdown")
    old_path = row.storage_path
    await overwrite_generated_file(db, user=user, file=row, content=b"# Final\n")
    assert row.storage_path != old_path
    [v] = (await db.execute(select(FileVersion).where(FileVersion.file_id == row.id))).scalars().all()
    assert v.source == "generated" and v.storage_path == old_path
    assert (root / old_path).read_bytes() == b"# Draft\n"


@pytest.mark.asyncio
async def test_retention_is_30_days_then_the_newest_100(db, user):
    from app.files.models import FileVersion, UserFile
    from app.files.versions import prune_versions

    f = UserFile(user_id=user.id, filename="a.txt", original_filename="a.txt", mime_type="text/plain",
                 size_bytes=1, storage_path=f"u_{user.id}/cur.txt")
    db.add(f)
    await db.flush()
    now = datetime.now(timezone.utc)
    # 90 recent versions and 30 old ones: 120 in all.
    for i in range(90):
        db.add(FileVersion(file_id=f.id, kind="blob", source="upload", size_bytes=1,
                           storage_path=f"u_{user.id}/r{i}.txt", created_at=now - timedelta(days=1, minutes=i)))
    for i in range(30):
        db.add(FileVersion(file_id=f.id, kind="blob", source="upload", size_bytes=1,
                           storage_path=f"u_{user.id}/o{i}.txt", created_at=now - timedelta(days=40, minutes=i),
                           label="Signed copy" if i == 29 else None))
    await db.commit()
    gone = await prune_versions(db)
    await db.commit()
    left = (await db.execute(select(FileVersion).where(FileVersion.file_id == f.id))).scalars().all()
    # Everything from the last 30 days, then the old ones up to 100 in all;
    # the named one stays whatever its age.
    assert gone == 19 and len(left) == 101
    assert any(v.label == "Signed copy" for v in left)


@pytest.mark.asyncio
async def test_replacing_counts_the_kept_version_toward_storage(client, db, user):
    from app.auth.models import User
    from app.files.quota import get_quota

    me = await db.get(User, user.id)
    me.storage_cap_bytes = 30
    await db.commit()
    assert (await get_quota(db, me)).versions_counted  # earlier versions count here
    await _upload(client, user, "log.txt", b"x" * 20)
    # The 20 bytes stay, as a version: 25 more don't fit, 9 do.
    r = await client.post("/api/files/", files={"file": ("log.txt", b"y" * 25, "text/plain")},
                          data={"scope": "mine", "on_conflict": "replace"}, headers=_auth(user))
    assert r.status_code == 413
    await _upload(client, user, "log.txt", b"z" * 9, conflict="replace")
    assert (await get_quota(db, me)).used_bytes == 29

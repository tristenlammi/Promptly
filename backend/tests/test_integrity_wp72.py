"""Integrity and guards (WP-7.2): the scrubber finds a corrupted or missing
file and tells the admins; orphans are quarantined, never deleted; uploads
stop before the disk fills; one device mass-deleting is flagged and can be
undone; sessions carry an id across refreshes."""
from __future__ import annotations

import os
import time
import uuid

import httpx
import pytest


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


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


@pytest.fixture
def alerts(monkeypatch):
    import app.notifications.dispatch as dispatch

    sent: list[dict] = []

    async def fake(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake)
    return sent


def _auth(user, sid: str | None = None):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version, session_id=sid)}"}


async def _upload(client, user, name, data=b"hello world\n", sid=None):
    r = await client.post("/api/files/", files={"file": (name, data, "text/plain")}, data={"scope": "mine"},
                          headers=_auth(user, sid))
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------------------------------------------------------------- the scrubber


@pytest.mark.asyncio
async def test_one_corrupted_byte_is_caught_and_the_admins_are_told(client, db, user, root, alerts):
    from app.files.models import StorageCheck, UserFile
    from app.files.scrubber import run_check
    from app.files.storage import absolute_path

    fid = await _upload(client, user, "taxes.txt", b"Return for 2025: refund 412.00\n")
    good = await _upload(client, user, "fine.txt", b"nothing wrong here\n")
    row = await db.get(UserFile, uuid.UUID(fid))
    path = absolute_path(row.storage_path)
    data = bytearray(path.read_bytes())
    data[5] ^= 0x01  # one flipped bit, same size
    path.write_bytes(bytes(data))

    out = await run_check(trigger="manual", orphans=False, budget_seconds=30)
    assert out["status"] == "problems" and out["damaged"] == 1 and out["verified"] == 2
    await db.refresh(row)
    assert row.blob_state == "damaged"
    assert (await db.get(UserFile, uuid.UUID(good))).blob_state == "ready"
    assert any("failed the storage check" in a["title"] and "taxes.txt" in a["body"] for a in alerts)
    # The file says so, wherever it's shown.
    meta = (await client.get(f"/api/files/{fid}", headers=_auth(user))).json()
    assert meta["blob_state"] == "damaged"
    check = (await db.execute(StorageCheck.__table__.select())).first()
    assert check.status == "problems"

    # Put back from a backup → "Check again" clears it.
    data[5] ^= 0x01
    path.write_bytes(bytes(data))
    r = await client.post(f"/api/admin/storage/files/{fid}/recheck", headers=_auth(user))
    assert r.json() == {"state": "ready"}


@pytest.mark.asyncio
async def test_a_missing_file_is_flagged_and_noticed_when_it_comes_back(client, db, user, root, alerts):
    from app.files.models import UserFile
    from app.files.scrubber import run_check
    from app.files.storage import absolute_path

    fid = await _upload(client, user, "photo.txt", b"pretend this is a photo\n")
    row = await db.get(UserFile, uuid.UUID(fid))
    path = absolute_path(row.storage_path)
    kept = path.read_bytes()
    path.unlink()
    out = await run_check(trigger="manual", orphans=False, budget_seconds=30)
    assert out["missing"] == 1
    await db.refresh(row)
    assert row.blob_state == "missing"

    path.write_bytes(kept)  # restored from a backup
    out = await run_check(trigger="manual", orphans=False, budget_seconds=30)
    assert out["recovered"] == 1 and out["status"] == "ok"
    await db.refresh(row)
    assert row.blob_state == "ready" and row.verified_at is not None


@pytest.mark.asyncio
async def test_orphans_are_quarantined_never_deleted(client, db, user, root):
    from app.files.models import StorageCheck
    from app.files.scrubber import empty_quarantine, orphan_walk, quarantine_summary
    from app.files.tombstones import tombstone

    await _upload(client, user, "keep.txt")
    bucket = root / f"u_{user.id}"
    orphan = bucket / f"{uuid.uuid4()}.bin"
    orphan.write_bytes(b"nobody points here")
    pending = bucket / f"{uuid.uuid4()}.bin"
    pending.write_bytes(b"purged, waiting out its 14 days")
    tombstone(db, f"u_{user.id}/{pending.name}", reason="purge", size_bytes=10)
    await db.commit()
    old = time.time() - 7200
    for p in bucket.iterdir():
        os.utime(p, (old, old))
    check = StorageCheck(checked=0, verified=0, bytes_verified=0, missing=0, damaged=0, recovered=0, quarantined=0)
    assert await orphan_walk(db, check) == 1
    assert not orphan.exists() and pending.exists()
    summary = quarantine_summary()
    assert summary["count"] == 1 and summary["items"][0]["path"] == f"u_{user.id}/{orphan.name}"
    assert empty_quarantine() == 1 and quarantine_summary()["count"] == 0


@pytest.mark.asyncio
async def test_storage_health_is_admin_only(client, db, user):
    from app.auth.models import User

    r = await client.get("/api/admin/storage/health", headers=_auth(user))
    assert r.status_code == 200
    body = r.json()
    assert {"disk", "checksums", "files", "problems", "quarantine", "runs"} <= set(body)
    assert isinstance(body["checksums"], bool)
    pleb = User(email=f"p-{uuid.uuid4().hex[:6]}@x.com", username=f"p{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(pleb)
    await db.commit()
    assert (await client.get("/api/admin/storage/health", headers=_auth(pleb))).status_code == 403


# ---------------------------------------------------------------- the disk


@pytest.mark.asyncio
async def test_uploads_pause_when_the_disk_is_nearly_full(client, user, root, monkeypatch, alerts):
    from app.files import disk_guard

    async def always(level):
        return True

    # The once-a-day marker lives in the shared Redis; don't depend on it.
    monkeypatch.setattr(disk_guard, "_once_today", always)
    monkeypatch.setenv("DISK_MIN_FREE_GB", "1000000")  # a floor no test disk clears
    r = await client.post("/api/files/", files={"file": ("a.txt", b"x", "text/plain")}, data={"scope": "mine"},
                          headers=_auth(user))
    assert r.status_code == 507 and "disk space" in r.json()["detail"]
    assert list(root.rglob("*.txt")) == []
    assert any("Uploads are paused" in a["title"] for a in alerts)


@pytest.mark.asyncio
async def test_admins_hear_at_85_and_95_percent(monkeypatch, alerts, user):
    from app.files import disk_guard

    async def always(level):
        return True

    monkeypatch.setattr(disk_guard, "_once_today", always)
    for used, level in ((50, None), (88, "warning"), (97, "critical")):
        monkeypatch.setattr(disk_guard, "usage", lambda u=used: disk_guard.DiskUsage(100_000, u * 1000, 100_000 - u * 1000, 1))
        assert await disk_guard.check_and_alert() == level


# ---------------------------------------------------------------- mass delete


@pytest.mark.asyncio
async def test_one_device_deleting_a_lot_is_flagged_and_can_be_undone(client, db, user, monkeypatch, alerts):
    from app.files import mass_delete
    from app.files.models import UserFile

    monkeypatch.setattr(mass_delete, "MAX_FILES", 3)
    mine = [await _upload(client, user, f"f{i}.txt") for i in range(5)]
    other = await _upload(client, user, "other-device.txt")

    # Another session deletes one file — not part of what gets undone.
    await client.post(f"/api/files/{other}/trash", headers=_auth(user, "laptop"))
    r = await client.post("/api/files/bulk/trash", json={"file_ids": mine, "folder_ids": []}, headers=_auth(user, "stolen"))
    assert r.status_code == 200 and r.json()["files"] == 5
    [alert] = [a for a in alerts if "were just deleted" in a["title"]]
    assert alert["user_id"] == user.id and alert["url"] == "/files/trash?restore=session:stolen"
    assert "5 files" in alert["body"]

    summary = (await client.get("/api/files/trash/restore-device", params={"credential": "session:stolen"},
                                headers=_auth(user, "laptop"))).json()
    assert summary["files"] == 5 and summary["this_device"] is False
    r = await client.post("/api/files/trash/restore-device", json={"credential": "session:stolen"},
                          headers=_auth(user, "laptop"))
    assert r.json() == {"files": 5, "folders": 0}
    rows = {str(f.id): f for f in (await db.execute(UserFile.__table__.select())).all()}
    assert all(rows[i].trashed_at is None for i in mine)
    assert rows[other].trashed_at is not None and rows[other].trashed_credential == "session:laptop"


@pytest.mark.asyncio
async def test_a_folder_trash_records_who_and_counts(client, db, user, monkeypatch, alerts):
    from app.files import mass_delete

    monkeypatch.setattr(mass_delete, "MAX_FILES", 2)
    f = (await client.post("/api/files/folders", json={"name": "Photos", "scope": "mine"}, headers=_auth(user))).json()
    for i in range(3):
        await client.post("/api/files/", files={"file": (f"p{i}.txt", b"x", "text/plain")},
                          data={"scope": "mine", "folder_id": f["id"]}, headers=_auth(user))
    await client.post(f"/api/files/folders/{f['id']}/trash", headers=_auth(user, "tablet"))
    assert any(a["url"] == "/files/trash?restore=session:tablet" for a in alerts)
    r = await client.post("/api/files/trash/restore-device", json={"credential": "session:tablet"},
                          headers=_auth(user, "tablet"))
    assert r.json() == {"files": 3, "folders": 1}


# ---------------------------------------------------------------- sessions


@pytest.mark.asyncio
async def test_a_session_keeps_its_id_across_refreshes(client, user):
    from app.auth.utils import create_refresh_token, decode_token

    refresh = create_refresh_token(user.id, token_version=user.token_version, session_id="abc123")
    client.cookies.set("promptly_refresh", refresh, path="/api/auth")
    r = await client.post("/api/auth/refresh")
    assert r.status_code == 200, r.text
    assert decode_token(r.json()["access_token"], expected_type="access")["sid"] == "abc123"


@pytest.mark.asyncio
async def test_pruned_pdf_versions_have_their_bytes_scheduled_for_deletion(db, user, root, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.files import blob_versions
    from app.files.models import BlobTombstone, FileVersion, UserFile
    from app.files.versions import prune_versions

    # Byte versions keep 30 days, then the newest 100 (WP-8.1) — 1 here.
    monkeypatch.setattr(blob_versions, "KEEP_MAX", 1)

    f = UserFile(user_id=user.id, filename="a.pdf", original_filename="a.pdf", mime_type="application/pdf",
                 size_bytes=1, storage_path=f"u_{user.id}/cur.pdf")
    db.add(f)
    await db.flush()
    now = datetime.now(timezone.utc)
    old = FileVersion(file_id=f.id, kind="pdf", source="edit", storage_path=f"u_{user.id}/old.pdf",
                      size_bytes=1, created_at=now - timedelta(days=40))
    shared = FileVersion(file_id=f.id, kind="pdf", source="edit", storage_path=f"u_{user.id}/cur.pdf",
                         size_bytes=1, created_at=now - timedelta(days=41))
    newest = FileVersion(file_id=f.id, kind="pdf", source="edit", storage_path=f"u_{user.id}/new.pdf",
                         size_bytes=1, created_at=now - timedelta(hours=1))
    db.add_all([old, shared, newest])
    await db.commit()
    assert await prune_versions(db) == 2
    await db.commit()
    paths = set((await db.execute(select(BlobTombstone.storage_path))).scalars())
    # The one the file itself still uses is kept.
    assert paths == {f"u_{user.id}/old.pdf"}

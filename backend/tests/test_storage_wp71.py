"""Storage model (WP-7.1): staged writes with hashes, nothing half-written
or rejected left behind, the storage cap held under concurrent uploads, and
a resumable hash backfill for older files."""
from __future__ import annotations

import asyncio
import hashlib
import io
import os
import time
import uuid

import httpx
import pytest


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _upload(client, user, name, data, mime="text/plain"):
    return await client.post("/api/files/", files={"file": (name, data, mime)}, data={"scope": "mine"},
                             headers=_auth(user))


def _files(root):
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


@pytest.mark.asyncio
async def test_an_upload_records_its_hashes_and_leaves_nothing_staged(client, db, user, tmp_path):
    from app.files.models import UserFile
    from app.files.storage import absolute_path

    data = b"Shopping list: eggs, milk, bread\n" * 50
    r = await _upload(client, user, "list.txt", data)
    assert r.status_code == 201, r.text
    row = await db.get(UserFile, uuid.UUID(r.json()["id"]))
    assert row.content_sha256 == hashlib.sha256(data).hexdigest()
    assert row.sha1 == hashlib.sha1(data).hexdigest()  # noqa: S324
    assert row.blob_state == "ready" and row.verified_at is not None
    assert absolute_path(row.storage_path).read_bytes() == data
    assert list((tmp_path / ".staging").iterdir()) == []


@pytest.mark.asyncio
async def test_a_rejected_upload_leaves_no_bytes_anywhere(client, user, tmp_path, monkeypatch):
    from app.files import router as files_router

    # Claims to be a PNG, isn't.
    r = await _upload(client, user, "photo.png", b"definitely not an image", "image/png")
    assert r.status_code == 400
    # Too big.
    monkeypatch.setattr(files_router, "MAX_FILE_BYTES", 16)
    r = await _upload(client, user, "big.txt", b"x" * 100)
    assert r.status_code == 413
    # Empty.
    r = await _upload(client, user, "empty.txt", b"")
    assert r.status_code == 400
    assert [f for f in _files(tmp_path)] == []


@pytest.mark.asyncio
async def test_two_uploads_at_once_cannot_overshoot_the_cap(client, db, user, tmp_path):
    from app.auth.models import User

    data = b"y" * 4000
    owner = await db.get(User, user.id)
    owner.storage_cap_bytes = 6000  # room for one, not two
    await db.commit()
    results = await asyncio.gather(
        _upload(client, user, "a.txt", data), _upload(client, user, "b.txt", data)
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [201, 413], [r.text for r in results]
    # Only the accepted one is on disk.
    assert len([f for f in _files(tmp_path) if f.startswith("u_")]) == 1


@pytest.mark.asyncio
async def test_the_backfill_hashes_older_files_and_marks_missing_ones(db, user, tmp_path, monkeypatch):
    from app.files import storage
    from app.files.blobstore import backfill_hashes
    from app.files.models import UserFile

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    old = b"an old upload from before hashes"
    rel = storage.storage_path_for(user.id, uuid.uuid4(), ".txt")
    storage.absolute_path(rel).parent.mkdir(parents=True, exist_ok=True)
    storage.absolute_path(rel).write_bytes(old)
    kept = UserFile(user_id=user.id, filename="old.txt", original_filename="old.txt", mime_type="text/plain",
                    size_bytes=len(old), storage_path=rel)
    gone = UserFile(user_id=user.id, filename="gone.txt", original_filename="gone.txt", mime_type="text/plain",
                    size_bytes=5, storage_path=storage.storage_path_for(user.id, uuid.uuid4(), ".txt"))
    # A Doc's HTML snapshot is rewritten all the time — never hashed.
    doc = UserFile(user_id=user.id, filename="d.html", original_filename="d.html", mime_type="text/html",
                   size_bytes=0, storage_path="u_x/none.html", source_kind="document")
    db.add_all([kept, gone, doc])
    await db.commit()

    out = await backfill_hashes(db, budget_seconds=30)
    assert out == {"hashed": 1, "missing": 1}
    await db.refresh(kept)
    await db.refresh(gone)
    await db.refresh(doc)
    assert kept.content_sha256 == hashlib.sha256(old).hexdigest() and kept.verified_at is not None
    assert gone.blob_state == "missing" and gone.content_sha256 is None
    assert doc.content_sha256 is None and doc.blob_state == "ready"
    # Resumable: nothing left to do.
    assert await backfill_hashes(db, budget_seconds=30) == {"hashed": 0, "missing": 0}


@pytest.mark.asyncio
async def test_generated_files_and_copies_carry_hashes(client, db, user, tmp_path):
    from app.files.generated import overwrite_generated_file, persist_generated_file
    from app.files.models import UserFile

    row = await persist_generated_file(db, user=user, content=b"# Report\n", filename="report.md",
                                       mime_type="text/markdown", source_kind="markdown_source")
    assert row.content_sha256 == hashlib.sha256(b"# Report\n").hexdigest()
    await overwrite_generated_file(db, user=user, file=row, content=b"# Report v2\n")
    await db.refresh(row)
    assert row.content_sha256 == hashlib.sha256(b"# Report v2\n").hexdigest() and row.size_bytes == 12
    assert list((tmp_path / ".staging").iterdir()) == []


def test_the_store_reads_ranges_and_cleans_stale_staging(tmp_path, monkeypatch):
    from app.files import blobstore, storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    staged = blobstore.blobstore.put_bytes("u_1/a.bin", bytes(range(256)) * 4)
    assert staged.size == 1024
    assert b"".join(blobstore.blobstore.open_range("u_1/a.bin", 10, 19)) == bytes(range(10, 20))
    assert blobstore.blobstore.stat("u_1/a.bin").size == 1024
    with pytest.raises(ValueError):
        blobstore.blobstore.xaccel_path("../../etc/passwd")

    stale = tmp_path / ".staging" / "leftover"
    stale.write_bytes(b"crash")
    fresh = tmp_path / ".staging" / "inflight"
    fresh.write_bytes(b"writing")
    os.utime(stale, (time.time() - 2 * 86400,) * 2)
    assert blobstore.clear_stale_staging() == 1
    assert not stale.exists() and fresh.exists()


def test_a_failed_stage_removes_its_partial_file(tmp_path, monkeypatch):
    from app.files import blobstore, storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    with pytest.raises(blobstore.BlobTooLarge):
        blobstore.blobstore.stage_stream(io.BytesIO(b"z" * 5000), size_limit=1000)
    assert list((tmp_path / ".staging").iterdir()) == []

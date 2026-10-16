"""Permanent deletes that really delete, and are recoverable for 14 days.

* R-025 — Trash "Delete forever" was a no-op for files and, for folders,
  unlinked the blobs while the file rows survived (unopenable, still on
  quota).
* Deferred deletion — purged bytes stay on disk until the tombstone sweep,
  which never removes a path a row still uses.
* Drive trash retention — items 30+ days in the trash are purged.
* R-027 — a document's inline images live outside the folder tree and go
  with the document; orphans are cleaned up; folder shares don't list them.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select

from app.files import storage
from app.files.models import BlobTombstone, FileFolder, UserFile
from app.files.purge import purge_expired_trash, purge_orphan_document_assets
from app.files.router import _BulkIds, bulk_purge, delete_folder, empty_trash
from app.files.tombstones import RETENTION_DAYS, sweep_due


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path.resolve()


async def _file(db, owner, root: Path, *, folder=None, trashed=False, kind=None, source=None, name="a.txt"):
    rel = f"u_{owner.id}/{uuid.uuid4()}.bin"
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 10)
    f = UserFile(
        user_id=owner.id, folder_id=folder.id if folder else None, filename=name,
        original_filename=name, mime_type="text/plain", size_bytes=10,
        storage_path=rel, source_kind=kind, source_file_id=source,
        trashed_at=datetime.now(timezone.utc) if trashed else None,
    )
    db.add(f)
    await db.commit()
    return f


async def _folder(db, owner, *, parent=None, trashed=False, name="F"):
    f = FileFolder(
        user_id=owner.id, parent_id=parent.id if parent else None, name=name,
        trashed_at=datetime.now(timezone.utc) if trashed else None,
    )
    db.add(f)
    await db.commit()
    return f


async def _ids(db, model):
    return set((await db.execute(select(model.id))).scalars())


@pytest.mark.asyncio
async def test_delete_forever_removes_a_trashed_file(db, user, root):
    f = await _file(db, user, root, trashed=True)

    res = await bulk_purge(_BulkIds(file_ids=[f.id]), db=db, user=user)

    assert res.files == 1
    assert f.id not in await _ids(db, UserFile)
    # Bytes are still there — on a 14-day timer, not gone.
    assert (root / f.storage_path).exists()
    t = (await db.execute(select(BlobTombstone))).scalar_one()
    assert t.storage_path == f.storage_path


@pytest.mark.asyncio
async def test_delete_forever_skips_live_files(db, user, root):
    f = await _file(db, user, root)

    res = await bulk_purge(_BulkIds(file_ids=[f.id]), db=db, user=user)

    assert res.files == 0
    assert f.id in await _ids(db, UserFile)


@pytest.mark.asyncio
async def test_folder_purge_takes_its_files_and_spares_a_restored_one(db, user, root):
    top = await _folder(db, user, trashed=True)
    sub = await _folder(db, user, parent=top, trashed=True)
    gone = await _file(db, user, root, folder=sub, trashed=True)
    restored = await _file(db, user, root, folder=top)  # restored on its own

    res = await bulk_purge(_BulkIds(folder_ids=[top.id]), db=db, user=user)

    assert (res.folders, res.files) == (1, 1)
    ids = await _ids(db, UserFile)
    assert gone.id not in ids and restored.id in ids
    await db.refresh(restored)
    assert restored.folder_id is None  # lifted to the root, still opens
    assert (root / restored.storage_path).exists()


@pytest.mark.asyncio
async def test_old_folder_delete_route_no_longer_strands_rows(db, user, root):
    top = await _folder(db, user, trashed=True)
    f = await _file(db, user, root, folder=top, trashed=True)

    await delete_folder(top.id, db=db, user=user)

    assert f.id not in await _ids(db, UserFile)


@pytest.mark.asyncio
async def test_sweep_unlinks_only_after_the_window_and_never_a_live_path(db, user, root):
    a = await _file(db, user, root, trashed=True)
    b = await _file(db, user, root, trashed=True)
    await empty_trash(scope="mine", db=db, user=user)
    # Something references ``b``'s path again (e.g. restored from a dump).
    db.add(UserFile(user_id=user.id, filename="b", original_filename="b",
                    mime_type="text/plain", size_bytes=10, storage_path=b.storage_path))
    await db.commit()

    assert await sweep_due(db) == (0, 0)
    later = datetime.now(timezone.utc) + timedelta(days=RETENTION_DAYS + 1)
    removed, freed = await sweep_due(db, now=later)

    assert (removed, freed) == (1, 10)
    assert not (root / a.storage_path).exists()
    assert (root / b.storage_path).exists()
    assert (await db.execute(select(BlobTombstone))).first() is None


@pytest.mark.asyncio
async def test_drive_trash_expires_after_thirty_days(db, user, root):
    old = await _file(db, user, root, trashed=True)
    old.trashed_at = datetime.now(timezone.utc) - timedelta(days=31)
    recent = await _file(db, user, root, trashed=True)
    await db.commit()

    assert await purge_expired_trash(db) == 1
    await db.commit()

    ids = await _ids(db, UserFile)
    assert old.id not in ids and recent.id in ids


@pytest.mark.asyncio
async def test_purging_a_document_purges_its_images(db, user, root):
    doc = await _file(db, user, root, trashed=True, kind="document", name="d.html")
    img = await _file(db, user, root, kind="document_asset", source=doc.id, name="i.png")

    await bulk_purge(_BulkIds(file_ids=[doc.id]), db=db, user=user)

    assert img.id not in await _ids(db, UserFile)


@pytest.mark.asyncio
async def test_orphaned_images_are_cleaned_up(db, user, root):
    orphan = await _file(db, user, root, kind="document_asset", name="i.png")

    assert await purge_orphan_document_assets(db) == 1
    await db.commit()

    assert orphan.id not in await _ids(db, UserFile)


@pytest.mark.asyncio
async def test_trashing_a_folder_leaves_a_moved_documents_images_alone(db, user, root):
    """The R-027 scenario: images used to sit in the folder the document
    was created in, so trashing that folder broke the moved document."""
    from app.files.router import trash_folder

    old_home = await _folder(db, user)
    doc = await _file(db, user, root, kind="document", name="d.html")  # moved out
    img = await _file(db, user, root, kind="document_asset", source=doc.id)
    assert img.folder_id is None  # new assets never live in a folder

    await trash_folder(old_home.id, db=db, user=user)
    await db.refresh(img)

    assert img.trashed_at is None

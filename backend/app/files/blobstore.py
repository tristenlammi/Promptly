"""Where file bytes live, and how they get there (WP-7.1, Part C §5.2).

One interface over the uploads directory — :class:`BlobStore` — with local
disk as the only bundled backend (no bundled S3/MinIO; an external object
store could implement the same methods later). Existing
``u_<user>/<uuid><ext>`` paths never move.

**Staged writes.** Bytes never appear at their final path half-written:

1. stream into ``.staging/<uuid>`` (off the event loop), computing sha256
   and sha1 as they go;
2. fsync the file;
3. the caller checks it (magic sniff, quota) while it's still staged;
4. ``os.replace`` into place and fsync the directory;
5. the caller inserts and commits the row.

On any failure the staged file is removed (and a crash leaves it in
``.staging``, which the nightly pass clears — never in a user's bucket).

**Hashes.** ``files.content_sha256`` / ``sha1`` are recorded for canonical
bytes — uploads, a document's pictures and audio, chat-made files — the
things that can't be regenerated. A Doc's HTML snapshot and the workspace
text mirrors are rewritten all the time from state that lives elsewhere, so
they aren't (:func:`is_canonical`). Rows from before this are hashed by a
throttled, resumable backfill (:func:`backfill_hashes`).
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Iterator, Protocol

from app.files import storage

logger = logging.getLogger("promptly.files.blobstore")

STAGING_DIR = ".staging"
_CHUNK = 1024 * 1024

# Blob states (``files.blob_state``).
READY = "ready"
INGESTING = "ingesting"
MISSING = "missing"
DAMAGED = "damaged"

# source_kind values whose blob is the real thing (NULL — an upload — too).
CANONICAL_KINDS = ("document_asset", "markdown_source", "rendered_pdf")


def is_canonical(row) -> bool:  # noqa: ANN001 — UserFile
    kind = getattr(row, "source_kind", None)
    return kind is None or kind in CANONICAL_KINDS


def canonical_sql(alias: str = "f") -> str:
    kinds = ", ".join(f"'{k}'" for k in CANONICAL_KINDS)
    return f"({alias}.source_kind IS NULL OR {alias}.source_kind IN ({kinds}))"


class BlobTooLarge(ValueError):
    pass


@dataclass
class Staged:
    """Bytes written to ``.staging`` and hashed, not yet in place."""

    path: Path
    size: int
    sha256: str
    sha1: str
    md5: str = ""
    committed: bool = False


@dataclass
class BlobInfo:
    size: int
    mtime: float


class BlobStore(Protocol):
    def stage_stream(self, src: IO[bytes], *, size_limit: int) -> Staged: ...
    def stage_bytes(self, data: bytes) -> Staged: ...
    def commit(self, staged: Staged, rel_path: str) -> None: ...
    def discard(self, staged: Staged) -> None: ...
    def put_bytes(self, rel_path: str, data: bytes) -> Staged: ...
    def open_range(self, rel_path: str, start: int = 0, end: int | None = None) -> Iterator[bytes]: ...
    def stat(self, rel_path: str) -> BlobInfo | None: ...
    def exists(self, rel_path: str) -> bool: ...
    def hash_file(self, rel_path: str) -> tuple[str, str, int]: ...
    def hashes(self, rel_path: str) -> tuple[str, str, str, int]: ...
    def xaccel_path(self, rel_path: str) -> str: ...


def _fsync_dir(path: Path) -> None:
    """Make a rename durable. Not every platform can open a directory."""
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class LocalBlobStore:
    """The uploads directory on local disk (``storage.UPLOAD_ROOT``, read
    each call so tests can point it elsewhere)."""

    @property
    def root(self) -> Path:
        return storage.UPLOAD_ROOT

    def _staging(self) -> Path:
        d = self.root / STAGING_DIR
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ------------------------------------------------------------ writing

    def stage_stream(self, src: IO[bytes], *, size_limit: int = storage.MAX_FILE_BYTES) -> Staged:
        path = self._staging() / uuid.uuid4().hex
        h256, h1, h5 = hashlib.sha256(), hashlib.sha1(), hashlib.md5()  # noqa: S324 — sync-client checksums, not security
        total = 0
        try:
            with open(path, "wb") as out:
                while True:
                    chunk = src.read(_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > size_limit:
                        raise BlobTooLarge("file exceeds maximum size")
                    h256.update(chunk)
                    h1.update(chunk)
                    h5.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return Staged(path=path, size=total, sha256=h256.hexdigest(), sha1=h1.hexdigest(), md5=h5.hexdigest())

    def stage_bytes(self, data: bytes) -> Staged:
        import io

        return self.stage_stream(io.BytesIO(data), size_limit=max(len(data), 1))

    def adopt(self, path: Path) -> Staged:
        """Take a finished file from elsewhere on the uploads disk (a tus
        upload, WP-8.2) into staging — a rename, not a copy — and hash it."""
        staged_path = self._staging() / uuid.uuid4().hex
        os.replace(path, staged_path)
        h256, h1, h5 = hashlib.sha256(), hashlib.sha1(), hashlib.md5()  # noqa: S324 — sync-client checksums
        size = 0
        with open(staged_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(_CHUNK * 8), b""):
                h256.update(chunk)
                h1.update(chunk)
                h5.update(chunk)
                size += len(chunk)
        return Staged(path=staged_path, size=size, sha256=h256.hexdigest(), sha1=h1.hexdigest(), md5=h5.hexdigest())

    def commit(self, staged: Staged, rel_path: str) -> None:
        """Move a staged blob to ``rel_path`` (replacing what's there)."""
        dest = storage.absolute_path(rel_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            # nginx (another user) serves blobs read-only (WP-7.5).
            os.chmod(staged.path, 0o644)
        except OSError:
            pass
        os.replace(staged.path, dest)
        _fsync_dir(dest.parent)
        staged.committed = True

    def discard(self, staged: Staged) -> None:
        if not staged.committed:
            staged.path.unlink(missing_ok=True)

    def put_bytes(self, rel_path: str, data: bytes) -> Staged:
        """Stage and commit ``data`` at ``rel_path`` in one go."""
        staged = self.stage_bytes(data)
        try:
            self.commit(staged, rel_path)
        except BaseException:
            self.discard(staged)
            raise
        return staged

    # ------------------------------------------------------------ reading

    def open_range(self, rel_path: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
        """Bytes ``start``..``end`` (inclusive), in chunks."""
        path = storage.absolute_path(rel_path)
        with open(path, "rb") as fh:
            fh.seek(start)
            left = None if end is None else end - start + 1
            while left is None or left > 0:
                chunk = fh.read(_CHUNK if left is None else min(_CHUNK, left))
                if not chunk:
                    break
                if left is not None:
                    left -= len(chunk)
                yield chunk

    def stat(self, rel_path: str) -> BlobInfo | None:
        try:
            st = storage.absolute_path(rel_path).stat()
        except (OSError, ValueError):
            return None
        return BlobInfo(size=st.st_size, mtime=st.st_mtime)

    def exists(self, rel_path: str) -> bool:
        return self.stat(rel_path) is not None

    def hash_file(self, rel_path: str) -> tuple[str, str, int]:
        """(sha256, sha1, size) of what's on disk."""
        sha256, sha1, _md5, size = self.hashes(rel_path)
        return sha256, sha1, size

    def hashes(self, rel_path: str) -> tuple[str, str, str, int]:
        """(sha256, sha1, md5, size) of what's on disk."""
        h256, h1, h5 = hashlib.sha256(), hashlib.sha1(), hashlib.md5()  # noqa: S324
        size = 0
        for chunk in self.open_range(rel_path):
            h256.update(chunk)
            h1.update(chunk)
            h5.update(chunk)
            size += len(chunk)
        return h256.hexdigest(), h1.hexdigest(), h5.hexdigest(), size

    def xaccel_path(self, rel_path: str) -> str:
        """The nginx-internal location serving this blob (WP-7.5)."""
        storage.absolute_path(rel_path)  # refuses an escaping path
        return f"/_blobs/{rel_path}"


blobstore: BlobStore = LocalBlobStore()


# ---------------------------------------------------------------- rows


def record(row, staged: Staged) -> None:  # noqa: ANN001 — UserFile
    """Copy a staged blob's size and hashes onto its row (just written, so
    verified now)."""
    row.size_bytes = staged.size
    if is_canonical(row):
        row.content_sha256 = staged.sha256
        row.sha1 = staged.sha1
        row.md5 = staged.md5 or None
        row.verified_at = datetime.now(timezone.utc)
    row.blob_state = READY


async def hash_into(row) -> None:  # noqa: ANN001 — UserFile
    """Hash what's at ``row.storage_path`` now and record it — for writes
    that change the bytes after they land (a document picture's metadata is
    stripped in place) or that don't go through staging."""
    if not is_canonical(row):
        return
    sha256, sha1, md5, _size = await asyncio.to_thread(blobstore.hashes, row.storage_path)
    row.content_sha256, row.sha1, row.md5 = sha256, sha1, md5
    row.verified_at = datetime.now(timezone.utc)
    row.blob_state = READY


async def stage_upload(src: IO[bytes], *, size_limit: int = storage.MAX_FILE_BYTES) -> Staged:
    """:meth:`BlobStore.stage_stream` off the event loop — the API runs one
    worker, so a big write must never block it."""
    return await asyncio.to_thread(blobstore.stage_stream, src, size_limit=size_limit)


async def stage_body(chunks, *, size_limit: int) -> Staged:  # noqa: ANN001 — AsyncIterator[bytes]
    """Stream a request body (a WebDAV PUT, WP-8.4) into staging, hashing as
    it goes. Writes and hashes run off the event loop, a megabyte at a time."""
    path = blobstore._staging() / uuid.uuid4().hex  # type: ignore[attr-defined]
    h256, h1, h5 = hashlib.sha256(), hashlib.sha1(), hashlib.md5()  # noqa: S324 — sync-client checksums, not security
    total = 0
    buf = bytearray()
    out = await asyncio.to_thread(open, path, "wb")

    def write(data: bytes) -> None:
        h256.update(data)
        h1.update(data)
        h5.update(data)
        out.write(data)

    try:
        async for chunk in chunks:
            if not chunk:
                continue
            total += len(chunk)
            if total > size_limit:
                raise BlobTooLarge("file exceeds maximum size")
            buf += chunk
            if len(buf) >= _CHUNK:
                await asyncio.to_thread(write, bytes(buf))
                buf.clear()
        if buf:
            await asyncio.to_thread(write, bytes(buf))

        def finish() -> None:
            out.flush()
            os.fsync(out.fileno())
            out.close()

        await asyncio.to_thread(finish)
    except BaseException:
        out.close()
        path.unlink(missing_ok=True)
        raise
    return Staged(path=path, size=total, sha256=h256.hexdigest(), sha1=h1.hexdigest(), md5=h5.hexdigest())


async def put_bytes(rel_path: str, data: bytes) -> Staged:
    return await asyncio.to_thread(blobstore.put_bytes, rel_path, data)


def clear_stale_staging(max_age_seconds: float = 24 * 3600) -> int:
    """Remove staged files a crash left behind (nightly)."""
    d = storage.UPLOAD_ROOT / STAGING_DIR
    removed = 0
    cutoff = time.time() - max_age_seconds
    try:
        entries = list(d.iterdir())
    except OSError:
        return 0
    for p in entries:
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            pass
    return removed


async def backfill_hashes(db, *, budget_seconds: float = 240.0, batch: int = 50) -> dict[str, int]:  # noqa: ANN001
    """Hash canonical rows written before hashes were recorded, oldest
    first, within ``budget_seconds`` — resumable (it just picks up the rows
    still without a hash). A row whose blob is gone is marked missing."""
    from sqlalchemy import select, text

    import app.auth.models  # noqa: F401 — files.user_id's FK target, for a bare worker process
    from app.files.models import UserFile

    started = time.monotonic()
    out = {"hashed": 0, "missing": 0}
    while time.monotonic() - started < budget_seconds:
        ids = (
            await db.execute(
                text(
                    f"SELECT f.id FROM files AS f WHERE (f.content_sha256 IS NULL OR f.md5 IS NULL) AND {canonical_sql('f')} "
                    "AND f.blob_state = 'ready' ORDER BY f.created_at LIMIT :n"
                ),
                {"n": batch},
            )
        ).scalars().all()
        if not ids:
            break
        rows = (await db.execute(select(UserFile).where(UserFile.id.in_(ids)))).scalars().all()
        for row in rows:
            try:
                sha256, sha1, md5, size = await asyncio.to_thread(blobstore.hashes, row.storage_path)
            except (OSError, ValueError):
                row.blob_state = MISSING
                out["missing"] += 1
                continue
            if row.content_sha256 and row.content_sha256 != sha256:
                # Not the bytes it was recorded with (an MD5 pass over an
                # older row, WP-8.4): damaged, as the scrubber would say.
                row.blob_state = DAMAGED
                out["damaged"] = out.get("damaged", 0) + 1
                continue
            row.content_sha256, row.sha1, row.md5 = sha256, sha1, md5
            row.verified_at = datetime.now(timezone.utc)
            if size != row.size_bytes:
                logger.warning("backfill: %s is %d bytes on disk, %d recorded", row.id, size, row.size_bytes)
            out["hashed"] += 1
        await db.commit()
    return out


__all__ = [
    "BlobStore",
    "BlobTooLarge",
    "CANONICAL_KINDS",
    "LocalBlobStore",
    "Staged",
    "backfill_hashes",
    "blobstore",
    "canonical_sql",
    "clear_stale_staging",
    "hash_into",
    "is_canonical",
    "put_bytes",
    "record",
    "stage_upload",
]

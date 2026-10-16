"""Zip downloads as a job (WP-7.6, Part C §5.9, R-028).

The zip used to be built in memory on the API's one worker and pulled into
the browser over XHR: anything past a few tens of MB never finished, every
nested folder was flattened into its top folder, and files you could only
*read* (shared with you) were silently left out.

Now ``POST /api/files/bulk/zip`` checks the selection (read access is
enough), works out every entry with its full folder path, and queues a job
on the background worker that writes the archive to a temporary file —
already-compressed photos, videos and archives are stored, not deflated
again. The browser polls ``GET /api/files/zips/{id}`` and, when it's ready,
downloads it from a signed link that nginx serves (resumable, no timeout).
Archives are deleted a few hours later.

Job state lives in Redis (it's transient), the archive under
``derived/zips/``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files import storage

logger = logging.getLogger("promptly.files.zip_jobs")

MAX_FILES = 10_000
MAX_BYTES = 20 * 1024 ** 3  # 20 GB of source data
TTL_SECONDS = 6 * 3600
_KEY = "promptly:zipjob:{}"

# Already compressed: deflating again costs CPU and saves nothing.
_STORED_EXTS = frozenset(
    ".jpg .jpeg .png .gif .webp .heic .heif .avif .mp4 .mov .m4v .3gp .webm .mkv .mp3 .m4a .aac .ogg .opus .flac "
    ".zip .gz .tgz .bz2 .xz .7z .rar .pdf .docx .xlsx .pptx .odt .ods .odp .dng .cr2 .cr3 .nef .arw".split()
)


def zip_dir() -> Path:
    return storage.UPLOAD_ROOT / "derived" / "zips"


def zip_path(job_id: uuid.UUID | str) -> Path:
    return zip_dir() / f"{job_id}.zip"


class ZipTooLarge(Exception):
    pass


# ------------------------------------------------------------------ planning


async def plan(db: AsyncSession, user: Any, file_ids: list[uuid.UUID], folder_ids: list[uuid.UUID]) -> dict[str, Any]:
    """Every entry of the archive: ``[arcname, kind, ref]`` where kind is
    ``blob`` (ref = storage path), ``shell`` (a sheet / whiteboard, ref =
    file id, exported when the zip is built) or ``dir`` (an empty folder).
    Skips what the caller can't read. Raises :class:`ZipTooLarge`."""
    from fastapi import HTTPException

    from app.files.models import FileFolder, UserFile
    from app.files.office import is_shell
    from app.files.router import _drive_listing_filter, _load_readable_file, _load_readable_folder

    entries: list[list[str]] = []
    seen: set[str] = set()
    total = 0

    def unique(arcname: str) -> str:
        """Two entries with one name get "name (1).ext" (or "name (1)/")."""
        name, i = arcname, 1
        while name in seen:
            if arcname.endswith("/"):
                name = f"{arcname[:-1]} ({i})/"
            else:
                head, _, base = arcname.rpartition("/")
                stem, dot, ext = base.rpartition(".")
                base = f"{stem} ({i}).{ext}" if dot and stem else f"{base} ({i})"
                name = f"{head}/{base}" if head else base
            i += 1
        seen.add(name)
        return name

    def add(prefix: str, row: UserFile) -> None:
        nonlocal total
        if is_shell(row):
            entries.append([unique(prefix + row.filename), "shell", str(row.id)])
        elif row.storage_path and storage.absolute_path(row.storage_path).is_file():
            entries.append([unique(prefix + row.filename), "blob", row.storage_path])
            total += int(row.size_bytes or 0)

    for fid in file_ids:
        try:
            row = await _load_readable_file(db, fid, user)
        except HTTPException:
            continue
        if row.trashed_at is None:
            add("", row)

    for did in folder_ids:
        try:
            top = await _load_readable_folder(db, did, user)
        except HTTPException:
            continue
        if top.trashed_at is not None:
            continue
        # The whole subtree, with each folder's path inside the zip.
        paths: dict[uuid.UUID, str] = {top.id: unique(top.name + "/")}
        parents: set[uuid.UUID] = set()
        frontier = [top.id]
        while frontier:
            children = (
                await db.execute(
                    select(FileFolder.id, FileFolder.name, FileFolder.parent_id)
                    .where(FileFolder.parent_id.in_(frontier), FileFolder.trashed_at.is_(None))
                    .order_by(FileFolder.name)
                )
            ).all()
            frontier = []
            for cid, name, parent_id in children:
                paths[cid] = unique(paths[parent_id] + name + "/")
                parents.add(parent_id)
                frontier.append(cid)
        files = (
            await db.execute(
                select(UserFile)
                .where(UserFile.folder_id.in_(list(paths)), UserFile.trashed_at.is_(None), _drive_listing_filter())
                .order_by(UserFile.filename)
            )
        ).scalars().all()
        holding = set()
        for f in files:
            add(paths[f.folder_id], f)
            holding.add(f.folder_id)
        # Empty folders are kept, so the structure comes back as it was.
        for folder_id, path in paths.items():
            if folder_id not in holding and folder_id not in parents:
                entries.append([path, "dir", ""])
        if len(entries) > MAX_FILES:
            break

    if len(entries) > MAX_FILES:
        raise ZipTooLarge(f"Too many files to zip at once (max {MAX_FILES:,}). Select fewer items.")
    if total > MAX_BYTES:
        raise ZipTooLarge("Selection is too large to zip in one go (max 20 GB). Download it in smaller batches.")
    return {"entries": entries, "bytes": total}


def archive_name(folder_names: list[str], n_files: int) -> str:
    if len(folder_names) == 1 and n_files == 0:
        return f"{folder_names[0]}.zip"
    return "promptly-files.zip"


# ------------------------------------------------------------------ state


async def _redis():
    from app.redis_client import redis

    return redis


async def save(job_id: str, state: dict[str, Any]) -> None:
    await (await _redis()).set(_KEY.format(job_id), json.dumps(state), ex=TTL_SECONDS)


async def load(job_id: str) -> dict[str, Any] | None:
    raw = await (await _redis()).get(_KEY.format(job_id))
    return json.loads(raw) if raw else None


async def create(user_id: uuid.UUID, planned: dict[str, Any], name: str) -> str:
    job_id = str(uuid.uuid4())
    await save(job_id, {
        "user_id": str(user_id), "state": "queued", "name": name,
        "entries": planned["entries"], "source_bytes": planned["bytes"],
        "files": sum(1 for e in planned["entries"] if e[1] != "dir"),
        "done": 0, "bytes": 0, "error": None, "created": time.time(),
    })
    return job_id


async def start(job_id: str) -> None:
    """On the background worker; in this process (a thread for the
    writing) if the queue is down."""
    from app.tasks.queue import enqueue_zip

    await enqueue_zip(job_id)


# ------------------------------------------------------------------ building


async def build(job_id: str) -> str:
    """Write the archive. Returns the final state."""
    from app.database import SessionLocal
    from app.files.models import UserFile
    from app.files.office import content_for_shell, export_for_download

    job = await load(job_id)
    if job is None or job["state"] not in ("queued", "building"):
        return job["state"] if job else "gone"
    job["state"] = "building"
    await save(job_id, job)

    # Sheets and whiteboards are exported from their live content first
    # (small, and it needs the database).
    exported: dict[str, tuple[str, bytes]] = {}
    shells = [e for e in job["entries"] if e[1] == "shell"]
    if shells:
        async with SessionLocal() as db:
            for arcname, _kind, ref in shells:
                row = await db.get(UserFile, uuid.UUID(ref))
                entity = await content_for_shell(db, row) if row is not None else None
                if entity is None:
                    continue
                data, name, _mime = await asyncio.to_thread(export_for_download, row, entity)
                folder = arcname.rpartition("/")[0]
                exported[ref] = ((folder + "/" if folder else "") + name, data)

    progress = {"done": 0, "bytes": 0}
    out = zip_path(job_id)

    def write() -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        part = out.with_suffix(".zip.part")
        with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for arcname, kind, ref in job["entries"]:
                if kind == "dir":
                    zf.writestr(zipfile.ZipInfo(arcname), b"")
                    continue
                if kind == "shell":
                    if ref not in exported:
                        continue
                    name, data = exported[ref]
                    zf.writestr(name, data)
                else:
                    src = storage.absolute_path(ref)
                    try:
                        compress = zipfile.ZIP_STORED if src.suffix.lower() in _STORED_EXTS or Path(arcname).suffix.lower() in _STORED_EXTS else zipfile.ZIP_DEFLATED
                        zf.write(src, arcname=arcname, compress_type=compress)
                    except FileNotFoundError:
                        continue
                progress["done"] += 1
        os.chmod(part, 0o644)  # nginx serves it
        os.replace(part, out)
        progress["bytes"] = out.stat().st_size

    async def report() -> None:
        while True:
            await asyncio.sleep(1.0)
            job["done"] = progress["done"]
            await save(job_id, job)

    reporter = asyncio.create_task(report())
    try:
        await asyncio.to_thread(write)
    except Exception as e:  # noqa: BLE001 — the user is told; nothing half-written stays
        logger.exception("zip job %s failed", job_id)
        out.with_suffix(".zip.part").unlink(missing_ok=True)
        job.update(state="failed", error="The zip couldn't be made. Try again, or download fewer items.")
        if isinstance(e, OSError) and e.errno == 28:
            job["error"] = "The server ran out of disk space making the zip."
        return await _finish(job_id, job, reporter)
    job.update(state="ready", done=progress["done"], bytes=progress["bytes"])
    return await _finish(job_id, job, reporter)


async def _finish(job_id: str, job: dict[str, Any], reporter: asyncio.Task) -> str:
    reporter.cancel()
    try:
        await reporter
    except asyncio.CancelledError:
        pass
    # The plan isn't needed once it's built.
    job["entries"] = []
    await save(job_id, job)
    return job["state"]


def sweep(max_age: int = TTL_SECONDS) -> int:
    """Delete archives (and half-written ones) older than ``max_age``."""
    root = zip_dir()
    if not root.is_dir():
        return 0
    cutoff = time.time() - max_age
    n = 0
    for p in root.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            continue
    return n


__all__ = ["MAX_BYTES", "MAX_FILES", "ZipTooLarge", "archive_name", "build", "create", "load", "plan", "start", "sweep", "zip_path"]

"""Running an import (WP-10.2, Part C §4.9).

From the plan the index wrote (``jobs.index``):

1. **Photos and videos**, part by part — a ``.tgz`` read once from start to
   end, a ``.zip`` member by member. Each is staged and hashed; one whose
   bytes are already in your Files (a phone backup, an earlier import, the
   same photo twice in the Takeout) isn't stored again. A new one goes
   through the one upload path into Camera Uploads/YYYY/MM (type checks,
   storage, the media worker), with what Google knew kept beside it
   (``file_import_meta``: date taken, place, description, archived — the
   media worker reads the photo's own first, ``media_meta``). Favourites
   are starred.
2. **Albums** by title — an album you already have with that name is used.
3. **Drive files** into "Google Drive", their folders kept.

Progress is saved as it goes and the run checks for a cancel between
photos. If the worker stops part-way, the watchdog starts it again; since
everything already in is recognised by its hash, carrying on re-imports
nothing. The parts are deleted when it's done.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.photos.library import user_zone
from starlette.requests import Request as StarletteRequest

logger = logging.getLogger("promptly.imports.run")

BATCH_SECONDS = 2.0
STALE_MINUTES = 10
LOCK_SECONDS = 15 * 60
_LOCK = "promptly:import-run:{}"


def _request() -> StarletteRequest:
    """The audit log's view of the import: the server itself."""
    return StarletteRequest({
        "type": "http", "method": "POST", "path": "/api/imports", "headers": [], "client": None, "query_string": b"",
    })


class Cancelled(Exception):
    pass


class _Run:
    def __init__(self, job_id: uuid.UUID):
        self.job_id = job_id
        self.progress: dict[str, Any] = {}
        self.results: dict[int, str] = {}  # plan index → file id
        self.last_save = 0.0
        self.source = "takeout"

    # ---------------------------------------------------------------- state

    async def save(self, *, force: bool = False) -> None:
        from app.database import SessionLocal
        from app.imports.models import ImportJob

        if not force and time.monotonic() - self.last_save < BATCH_SECONDS:
            return
        self.last_save = time.monotonic()
        await _hold(self.job_id)
        async with SessionLocal() as db:
            job = await db.get(ImportJob, self.job_id)
            if job is None or job.state == "cancelled":
                raise Cancelled
            job.progress = dict(self.progress)
            await db.commit()

    def fail(self, name: str, reason: str) -> None:
        self.progress["failed"] += 1
        failures = self.progress.setdefault("failures", [])
        if len(failures) < 50:
            failures.append({"name": name, "reason": reason[:200]})


async def run(job_id: uuid.UUID | str) -> str:
    """Import everything in the plan. Returns the job's state."""
    from app.database import SessionLocal
    from app.imports import jobs
    from app.imports.models import ImportJob

    jid = uuid.UUID(str(job_id))
    async with SessionLocal() as db:
        job = await db.get(ImportJob, jid)
        if job is None or job.state != "importing":
            return job.state if job else "gone"
        user_id, parts = job.user_id, list(job.parts or [])
    if not await _take(jid):
        return "importing"  # another run of it is still going
    try:
        return await _run(jid, user_id, parts)
    finally:
        await _drop(jid)


async def _redis():  # noqa: ANN202
    from app.redis_client import redis

    return redis


async def _take(jid: uuid.UUID) -> bool:
    try:
        return bool(await (await _redis()).set(_LOCK.format(jid), "1", nx=True, ex=LOCK_SECONDS))
    except Exception:  # noqa: BLE001 — no Redis: run anyway (the hash dedupe keeps it safe)
        return True


async def _hold(jid: uuid.UUID) -> None:
    try:
        await (await _redis()).expire(_LOCK.format(jid), LOCK_SECONDS)
    except Exception:  # noqa: BLE001
        pass


async def _drop(jid: uuid.UUID) -> None:
    try:
        await (await _redis()).delete(_LOCK.format(jid))
    except Exception:  # noqa: BLE001
        pass


async def _running(jid: uuid.UUID) -> bool:
    try:
        return bool(await (await _redis()).exists(_LOCK.format(jid)))
    except Exception:  # noqa: BLE001
        return False


async def _run(jid: uuid.UUID, user_id: uuid.UUID, parts: list[dict]) -> str:
    from app.database import SessionLocal
    from app.imports import jobs
    from app.imports.models import ImportJob

    plan = json.loads(await asyncio.to_thread(jobs.plan_path(jid).read_text, "utf-8"))
    r = _Run(jid)
    r.source = plan.get("source") or "takeout"
    r.progress = {
        "done": 0, "total": len(plan["photos"]) + len(plan["drive"]) + len(plan.get("notes") or []), "imported": 0,
        "duplicates": 0, "failed": 0, "albums": 0, "drive": 0, "notes": 0, "failures": [], "stage": "photos",
    }
    try:
        await _photos(r, jid, user_id, parts, plan)
        r.progress["stage"] = "albums"
        await r.save(force=True)
        await _albums(r, user_id, plan)
        r.progress["stage"] = "drive"
        await _drive(r, jid, user_id, parts, plan)
        if plan.get("notes"):
            r.progress["stage"] = "notes"
            await r.save(force=True)
            await _notes(r, jid, user_id, parts, plan)
        state, error = "done", None
    except Cancelled:
        state, error = "cancelled", None
    except _Stop as stop:
        state, error = "failed", str(stop)
    except Exception:  # noqa: BLE001 — the person is told; the parts stay to try again
        logger.exception("import %s failed", jid)
        state, error = "failed", "The import stopped unexpectedly. Start it again — what's already in won't be copied twice."
    async with SessionLocal() as db:
        job = await db.get(ImportJob, jid)
        if job is None:
            return "gone"
        if job.state == "cancelled":
            state = "cancelled"
        job.state, job.error, job.progress = state, error, dict(r.progress)
        if state in ("done", "cancelled"):
            job.finished_at = datetime.now(timezone.utc)
        await db.commit()
    if state in ("done", "cancelled"):
        await asyncio.to_thread(jobs.remove_files, jid)
    if state == "done":
        await _tell(user_id, r.progress, r.source)
    return state


class _Stop(Exception):
    """Stops the whole import with a reason (out of storage, disk full)."""


async def _photos(r: _Run, jid: uuid.UUID, user_id: uuid.UUID, parts: list[dict], plan: dict[str, Any]) -> None:
    from app.imports import jobs
    from app.imports.takeout import open_member

    by_part: dict[int, list[int]] = {}
    for idx, p in enumerate(plan["photos"]):
        by_part.setdefault(p["part"], []).append(idx)
    for part_no, indexes in sorted(by_part.items()):
        path = jobs.job_dir(jid) / parts[part_no]["file"]
        for idx, stream in _members(path, [plan["photos"][i]["member"] for i in indexes], indexes, open_member):
            await _one_photo(r, jid, user_id, idx, plan["photos"][idx], stream)


def _members(path: Path, names: list[str], indexes: list[int], open_member):  # noqa: ANN001, ANN202
    """(plan index, file object) for each wanted member — a tar read once
    in order, a zip member by member."""
    import tarfile
    import zipfile

    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            for idx, name in zip(indexes, names):
                with zf.open(name) as f:
                    yield idx, f
        return
    wanted: dict[str, list[int]] = {}
    for idx, name in zip(indexes, names):
        wanted.setdefault(name, []).append(idx)
    with tarfile.open(path, "r:*") as tf:
        for m in tf:
            if m.name in wanted:
                f = tf.extractfile(m)
                if f is None:
                    continue
                for idx in wanted.pop(m.name):
                    yield idx, f
            if not wanted:
                break


async def _one_photo(r: _Run, jid: uuid.UUID, user_id: uuid.UUID, idx: int, item: dict[str, Any], stream) -> None:  # noqa: ANN001
    from fastapi import HTTPException

    from app.auth.models import User
    from app.database import SessionLocal
    from app.files import blobstore, disk_guard
    from app.files.models import UserFile
    from app.files.router import ingest_staged
    from app.files.tus_hooks import large_max_bytes
    from app.imports.models import FileImportMeta

    try:
        disk_guard.ensure_room(int(item["size"]))
    except disk_guard.DiskFull as e:
        raise _Stop(str(e)) from None
    async with SessionLocal() as db:
        cap = await large_max_bytes(db)
    try:
        staged = await asyncio.to_thread(blobstore.blobstore.stage_stream, stream, size_limit=max(cap, int(item["size"]) + 1))
    except Exception as e:  # noqa: BLE001 — one unreadable member doesn't stop the rest
        r.fail(item["name"], "couldn't be read from the archive" if not isinstance(e, blobstore.BlobTooLarge) else "too big")
        r.progress["done"] += 1
        await r.save()
        return
    try:
        async with SessionLocal() as db:
            from app.files.router import _already_in_camera_uploads

            user = await db.get(User, user_id)
            # A duplicate only when it's already in Photos — the same picture
            # filed elsewhere in My files isn't in the library.
            same_row = await _already_in_camera_uploads(db, user, staged.sha256)
            same = same_row.id if same_row is not None else None
            if same is not None:
                r.results[idx] = str(same)
                r.progress["duplicates"] += 1
            else:
                zone = user_zone(user)
                taken = item.get("taken") or _epoch(item.get("taken_naive"), zone)
                # The date to file it by when the photo has none of its own:
                # its details, else its year folder, else its date in the archive.
                fallback = taken or (
                    int(datetime(item["folder_year"], 1, 1, 12, tzinfo=timezone.utc).timestamp()) if item.get("folder_year") else None
                ) or item.get("mtime") or _epoch(item.get("mtime_naive"), zone)
                when_ms = fallback * 1000 if fallback else None
                try:
                    out = await ingest_staged(
                        db, request=_request(), user=user, staged=staged, filename=item["name"], declared_mime=item.get("mime"),
                        scope="mine", folder_id=None, route="camera", on_conflict="allow", workspace_id=None,
                        last_modified=when_ms,
                    )
                except HTTPException as e:
                    if e.status_code == 413:
                        raise _Stop("Your storage is full, so the import stopped. Free some space (or ask an admin for more) and start it again — it carries on where it stopped.") from None
                    detail = e.detail if isinstance(e.detail, str) else "not accepted"
                    r.fail(item["name"], detail)
                    r.progress["done"] += 1
                    await r.save()
                    return
                fid = out.id
                r.results[idx] = str(fid)
                if taken or item.get("lat") is not None or item.get("description") or item.get("archived"):
                    db.add(FileImportMeta(
                        file_id=fid, source=r.source, job_id=jid,
                        taken_at=datetime.fromtimestamp(taken, tz=timezone.utc) if taken else None,
                        lat=item.get("lat"), lon=item.get("lon"), description=item.get("description"),
                        archived=bool(item.get("archived")),
                    ))
                if item.get("favorite"):
                    row = await db.get(UserFile, fid)
                    if row is not None and row.starred_at is None:
                        row.starred_at = datetime.now(timezone.utc)
                await db.commit()
                r.progress["imported"] += 1
    finally:
        blobstore.blobstore.discard(staged)
    r.progress["done"] += 1
    await r.save()


async def _albums(r: _Run, user_id: uuid.UUID, plan: dict[str, Any]) -> None:
    from sqlalchemy.dialects.postgresql import insert

    from app.database import SessionLocal
    from app.photos.album_models import Album, AlbumItem

    async with SessionLocal() as db:
        for title, indexes in plan["albums"].items():
            ids = sorted({uuid.UUID(r.results[i]) for i in indexes if i in r.results})
            if not ids:
                continue
            album = (
                await db.execute(
                    select(Album).where(Album.owner_id == user_id, func.lower(Album.title) == title.strip().lower()).limit(1)
                )
            ).scalar_one_or_none()
            if album is None:
                album = Album(owner_id=user_id, title=title.strip()[:200] or "Untitled album")
                db.add(album)
                await db.flush()
                r.progress["albums"] += 1
            await db.execute(
                insert(AlbumItem)
                .values([{"album_id": album.id, "file_id": fid, "added_by": user_id} for fid in ids])
                .on_conflict_do_nothing(index_elements=["album_id", "file_id"])
            )
        await db.commit()


async def _drive(r: _Run, jid: uuid.UUID, user_id: uuid.UUID, parts: list[dict], plan: dict[str, Any]) -> None:
    from fastapi import HTTPException

    from app.auth.models import User
    from app.database import SessionLocal
    from app.files import blobstore, disk_guard
    from app.files.models import FileFolder, UserFile
    from app.files.router import ingest_staged
    from app.files.system_folders import _child_folder
    from app.imports import jobs
    from app.imports.takeout import open_member

    if not plan["drive"]:
        return
    by_part: dict[int, list[int]] = {}
    for idx, d in enumerate(plan["drive"]):
        by_part.setdefault(d["part"], []).append(idx)
    folders: dict[str, uuid.UUID] = {}
    root_name = (plan.get("files_root") or "Google Drive")[:255]

    async def folder_for(db, rel_dir: str) -> uuid.UUID:  # noqa: ANN001
        if rel_dir in folders:
            return folders[rel_dir]
        root = (
            await db.execute(
                select(FileFolder).where(
                    FileFolder.user_id == user_id, FileFolder.parent_id.is_(None), FileFolder.name == root_name,
                    FileFolder.trashed_at.is_(None),
                ).limit(1)
            )
        ).scalar_one_or_none()
        if root is None:
            root = FileFolder(user_id=user_id, name=root_name)
            db.add(root)
            await db.flush()
        current = root
        for seg in [s for s in rel_dir.split("/") if s]:
            current = await _child_folder(db, user_id, current.id, seg[:255])
        await db.commit()
        folders[rel_dir] = current.id
        return current.id

    for part_no, indexes in sorted(by_part.items()):
        path = jobs.job_dir(jid) / parts[part_no]["file"]
        for idx, stream in _members(path, [plan["drive"][i]["member"] for i in indexes], indexes, open_member):
            item = plan["drive"][idx]
            rel_dir, _, name = item["path"].rpartition("/")
            try:
                disk_guard.ensure_room(int(item["size"]))
            except disk_guard.DiskFull as e:
                raise _Stop(str(e)) from None
            try:
                staged = await asyncio.to_thread(blobstore.blobstore.stage_stream, stream, size_limit=int(item["size"]) + 1)
            except Exception:  # noqa: BLE001
                r.fail(name, "couldn't be read from the archive")
                r.progress["done"] += 1
                continue
            try:
                async with SessionLocal() as db:
                    same = await db.scalar(
                        select(UserFile.id).where(
                            UserFile.user_id == user_id, UserFile.content_sha256 == staged.sha256, UserFile.trashed_at.is_(None)
                        ).limit(1)
                    )
                    if same is not None:
                        r.progress["duplicates"] += 1
                    else:
                        user = await db.get(User, user_id)
                        try:
                            await ingest_staged(
                                db, request=_request(), user=user, staged=staged, filename=name, declared_mime=None,
                                scope="mine", folder_id=await folder_for(db, rel_dir), route=None, on_conflict="keep_both",
                                workspace_id=None, last_modified=None,
                            )
                            r.progress["drive"] += 1
                            r.progress["imported"] += 1
                        except HTTPException as e:
                            if e.status_code == 413:
                                raise _Stop("Your storage is full, so the import stopped. Free some space and start it again.") from None
                            r.fail(item["path"], e.detail if isinstance(e.detail, str) else "not accepted")
            finally:
                blobstore.blobstore.discard(staged)
            r.progress["done"] += 1
            await r.save()


# ------------------------------------------------------------------ notes (N1.6)

# Recordings browsers can't play (Keep's older voice notes are AMR in .3gp):
# made into .m4a on the way in.
_TRANSCODE_AUDIO = (".3gp", ".3gpp", ".amr")


def _playable(src: Path, name: str) -> tuple[Path, str] | None:
    """An .m4a (AAC) copy of a recording browsers can't play, beside it;
    None when ffmpeg can't (the original is imported as it is)."""
    import shutil
    import subprocess

    if shutil.which("ffmpeg") is None:
        return None
    out = src.with_name(src.name + ".m4a")
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "96k", str(out)],
            check=True, timeout=600, capture_output=True,
        )
    except (subprocess.SubprocessError, OSError):
        out.unlink(missing_ok=True)
        return None
    if not out.is_file() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        return None
    stem = name.rsplit(".", 1)[0] if "." in name else name
    return out, f"{stem}.m4a"


async def _notes(r: _Run, jid: uuid.UUID, user_id: uuid.UUID, parts: list[dict], plan: dict[str, Any]) -> None:
    """Google Keep notes (or a Promptly export's): each with its pictures
    and recordings (into My files › Notes; a photo from the library is the
    one imported above). A note already imported is skipped."""
    from fastapi import HTTPException

    from app.auth.models import User
    from app.database import SessionLocal
    from app.files import blobstore, disk_guard
    from app.files.models import UserFile
    from app.files.router import ingest_staged
    from app.imports import jobs
    from app.imports.takeout import open_member
    from app.notes import events, porting, transcription

    specs = list(plan.get("notes") or [])
    async with SessionLocal() as db:
        have = await porting.existing_refs(db, user_id, specs)
        cfg = await transcription.config(db)
    todo = [s for s in specs if s["ref"] not in have]
    skipped = len(specs) - len(todo)
    r.progress["duplicates"] += skipped
    r.progress["done"] += skipped
    await r.save(force=True)
    if not todo:
        return

    # Each archive part is read once, in order, for the files the new notes
    # need (a .tgz can't be read any other way).
    wanted: dict[int, dict[str, dict[str, Any]]] = {}
    for s in todo:
        for a in s.get("attachments") or []:
            if "member" in a:
                wanted.setdefault(int(a["part"]), {})[a["member"]] = a
    files_of: dict[tuple[int, str], uuid.UUID] = {}

    async def ingest(a: dict[str, Any], stream) -> None:  # noqa: ANN001
        name = str(a.get("name") or a["member"].rsplit("/", 1)[-1])[:255]
        try:
            disk_guard.ensure_room(int(a.get("size") or 0))
        except disk_guard.DiskFull as e:
            raise _Stop(str(e)) from None
        try:
            staged = await asyncio.to_thread(blobstore.blobstore.stage_stream, stream, size_limit=int(a.get("size") or 0) + 1)
        except Exception:  # noqa: BLE001
            r.fail(name, "couldn't be read from the archive")
            return
        converted: tuple[Path, str] | None = None
        try:
            if a.get("kind") == "audio" and name.lower().endswith(_TRANSCODE_AUDIO):
                converted = await asyncio.to_thread(_playable, staged.path, name)
                if converted is not None:
                    with open(converted[0], "rb") as f:
                        again = await asyncio.to_thread(
                            blobstore.blobstore.stage_stream, f, size_limit=converted[0].stat().st_size + 1
                        )
                    blobstore.blobstore.discard(staged)
                    staged, name = again, converted[1]
                    a = {**a, "mime": "audio/mp4"}
            async with SessionLocal() as db:
                same = await db.scalar(
                    select(UserFile.id).where(
                        UserFile.user_id == user_id, UserFile.content_sha256 == staged.sha256, UserFile.trashed_at.is_(None),
                        UserFile.storage_path.is_not(None),
                    ).limit(1)
                )
                if same is not None:
                    files_of[(int(a["part"]), a["member"])] = same
                    return
                user = await db.get(User, user_id)
                try:
                    out = await ingest_staged(
                        db, request=_request(), user=user, staged=staged, filename=name, declared_mime=a.get("mime") or None,
                        scope="mine", folder_id=None, route="note", on_conflict="keep_both", workspace_id=None, last_modified=None,
                    )
                except HTTPException as e:
                    if e.status_code == 413:
                        raise _Stop(
                            "Your storage is full, so the import stopped. Free some space and start it again — it carries on where it stopped."
                        ) from None
                    r.fail(name, e.detail if isinstance(e.detail, str) else "not accepted")
                    return
                row = await db.get(UserFile, out.id)
                if row is not None and a.get("kind") == "audio" and not (row.mime_type or "").startswith("audio/"):
                    # A recording in a video container (.3gp, .mp4): it's sound.
                    row.mime_type = "audio/mp4" if name.lower().endswith((".mp4", ".m4a")) else "audio/3gpp"
                    await db.commit()
                files_of[(int(a["part"]), a["member"])] = out.id
        finally:
            blobstore.blobstore.discard(staged)
            if converted is not None:
                converted[0].unlink(missing_ok=True)

    for part_no, members in sorted(wanted.items()):
        path = jobs.job_dir(jid) / parts[part_no]["file"]
        names = list(members)
        for i, stream in _members(path, names, list(range(len(names))), open_member):
            await ingest(members[names[i]], stream)
            await _hold(jid)

    for s in todo:
        files: list[tuple[uuid.UUID, str, str | None]] = []
        for a in s.get("attachments") or []:
            fid: uuid.UUID | None = None
            if "photo" in a:
                got = r.results.get(int(a["photo"]))
                fid = uuid.UUID(got) if got else None
            elif "member" in a:
                fid = files_of.get((int(a["part"]), a["member"]))
            if fid is not None:
                files.append((fid, a["kind"], a.get("transcript")))
        try:
            async with SessionLocal() as db:
                user = await db.get(User, user_id)
                note, audio = await porting.make_note(db, user, s, files, transcribe=cfg.on)
                await db.commit()
                event = events.note_event(note)
            r.progress["notes"] += 1
            r.progress["imported"] += 1
            try:
                await events.publish({user_id}, event)
            except Exception:  # noqa: BLE001 — live updates are a nicety
                pass
            for aid in audio:
                await transcription.enqueue(aid)
        except _Stop:
            raise
        except Exception as e:  # noqa: BLE001 — one note that won't go in doesn't stop the rest
            logger.warning("import %s: a note failed", jid, exc_info=True)
            detail = getattr(e, "detail", None)
            r.fail(str(s.get("title") or "A note"), detail if isinstance(detail, str) else "couldn't be made")
        r.progress["done"] += 1
        await r.save()


def _epoch(naive_iso: str | None, zone) -> int | None:  # noqa: ANN001 — ZoneInfo | None
    """A wall-clock time with no zone, read in the owner's (UTC without one)."""
    if not naive_iso:
        return None
    try:
        dt = datetime.fromisoformat(naive_iso)
    except ValueError:
        return None
    return int(dt.replace(tzinfo=zone or timezone.utc).timestamp())


_TITLES = {
    "takeout": "Your Google Takeout is in", "folder": "Your photos are in", "apple": "Your Apple photos are in",
    "keep": "Your Google Keep notes are in",
}


async def _tell(user_id: uuid.UUID, progress: dict[str, Any], source: str = "takeout") -> None:
    try:
        from app.notifications.dispatch import notify_user

        n = progress.get("imported", 0)
        notes = progress.get("notes", 0)
        only_notes = source == "keep" or bool(notes and notes == n)
        what = f"{notes} new {'note' if notes == 1 else 'notes'}" if only_notes else f"{n} new {'item' if n == 1 else 'items'}"
        await notify_user(
            user_id=user_id, category="import_done", title=_TITLES.get(source, "Your import is in"),
            body=what
            + (f", {progress.get('albums', 0)} albums" if progress.get("albums") else "")
            + (f", {notes} of them notes" if notes and not only_notes else "")
            + (f"; {progress.get('duplicates', 0)} you already had" if progress.get("duplicates") else "") + ".",
            url="/notes" if only_notes else "/files/photos",
        )
    except Exception:  # noqa: BLE001 — telling them must never fail the import
        logger.warning("import notification failed", exc_info=True)


async def enqueue_run(job_id: uuid.UUID) -> None:
    from app.tasks.queue import RUN_IMPORT, get_pool

    try:
        pool = await get_pool()
        await pool.enqueue_job(RUN_IMPORT, str(job_id), _job_id=f"import-run-{job_id}-{int(time.time())}")
        return
    except Exception:  # noqa: BLE001
        logger.warning("enqueue_run: queue unavailable, importing inline", exc_info=True)
    from app.background import spawn

    spawn(run(job_id), name=f"import_run_{job_id}")


async def watchdog() -> int:
    """An import whose progress hasn't moved for ten minutes lost its worker
    (a restart): start it again."""
    from datetime import timedelta

    from app.database import SessionLocal
    from app.imports.models import ImportJob

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STALE_MINUTES)
    async with SessionLocal() as db:
        stale = (
            await db.execute(select(ImportJob.id).where(ImportJob.state == "importing", ImportJob.updated_at < cutoff))
        ).scalars().all()
    restarted = 0
    for jid in stale:
        if not await _running(jid):  # a long video is still being copied otherwise
            await enqueue_run(jid)
            restarted += 1
    return restarted


__all__ = ["enqueue_run", "run", "watchdog"]

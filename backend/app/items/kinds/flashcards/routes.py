"""``/api/items/k/flashcards/…`` — Anki package import.

  ``POST /{file_id}/apkg``  multipart ``file`` (+ ``media``, ``history`` flags)
      → the package read into cards (with replayed FSRS state), review-log
        entries and deck paths. **Nothing in the item file changes here**:
        the client adds the cards with one ordinary ``item.update`` (so the
        save goes through the normal patch/offline path, and the card ids —
        derived from Anki's note guids — make a re-import skip what's there).
        Media referenced by the cards are stored in the person's Drive
        ("Flashcards media") and referenced as ``drive:<file id>``.

Needs the person signed in with edit access to the file.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.items import service

from . import apkg
from .cloze import ClozeError, validate_cloze

logger = logging.getLogger("promptly.items.flashcards")

router = APIRouter()

MEDIA_FOLDER = "Flashcards media"


async def _edit(db: AsyncSession, user: User, file_id: uuid.UUID):  # noqa: ANN202
    try:
        row, doc, _ = await service.load(db, user, file_id, need="edit")
    except service.ItemNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    if doc.kind != "flashcards":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return row, doc


async def _save_upload(file: UploadFile) -> str:
    fd, path = tempfile.mkstemp(suffix=".apkg")
    n = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                n += len(chunk)
                if n > apkg.MAX_APKG_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Packages up to {apkg.MAX_APKG_BYTES // (1024 * 1024)} MB can be imported — export the deck without media, or in parts.",
                    )
                out.write(chunk)
    except BaseException:
        os.unlink(path)
        raise
    return path


def _check_media(path: str, name: str) -> tuple[str, bytes] | None:
    """Sniff (magic bytes — the upload allowlist's rules), strip image
    metadata, and return (mime, bytes) — or None if it isn't a plain image
    or audio file. Runs in a thread."""
    from pathlib import Path

    from app.files.safety import UnsafeUploadError, sniff_and_validate, strip_image_metadata_in_place

    ext = os.path.splitext(name)[1].lower()
    if ext not in apkg.MEDIA_EXTS:
        return None
    p = Path(path)
    try:
        mime = sniff_and_validate(p, declared_filename=f"media{ext}", declared_mime=None)
    except UnsafeUploadError:
        return None
    if not (mime.startswith("image/") or mime.startswith("audio/")):
        return None
    if mime.startswith("image/"):
        strip_image_metadata_in_place(p, mime)
    return mime, p.read_bytes()


async def _store_media(db: AsyncSession, user: User, pkg: apkg.Package, path: str) -> tuple[dict[str, str], int]:
    """Referenced media → Drive files. (name → file id, how many failed)."""
    from app.files.generated import GeneratedFileError, persist_generated_file
    from app.files.safety import sanitize_filename
    from app.files.system_folders import get_or_create_subfolder

    ids: dict[str, str] = {}
    failed = 0
    names = [n for n in pkg.media_needed if n in pkg.media_map]
    if len(names) > apkg.MAX_MEDIA_FILES:
        pkg.warnings.append(f"Only the first {apkg.MAX_MEDIA_FILES} media files were imported.")
        failed += len(names) - apkg.MAX_MEDIA_FILES
        names = names[: apkg.MAX_MEDIA_FILES]
    if not names:
        return ids, failed
    folder = await get_or_create_subfolder(db, user_id=user.id, parent_id=None, name=MEDIA_FOLDER)
    total = 0
    for name in names:
        try:
            raw = await asyncio.to_thread(apkg.read_member, path, pkg.media_map[name])
        except (apkg.AnkiError, KeyError, OSError):
            failed += 1
            continue
        total += len(raw)
        if total > apkg.MAX_MEDIA_TOTAL_BYTES:
            pkg.warnings.append("The package's media are too large to import in full — the rest were left out.")
            failed += 1
            break
        ext = os.path.splitext(name)[1].lower()
        fd, tmp = tempfile.mkstemp(suffix=ext or ".bin")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            checked = await asyncio.to_thread(_check_media, tmp, name)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if checked is None:
            failed += 1
            continue
        mime, content = checked
        try:
            fname = sanitize_filename(name) or f"media{ext}"
            row = await persist_generated_file(db, user=user, filename=fname, mime_type=mime, content=content)
            row.folder_id = folder.id
            await db.commit()
            ids[name] = str(row.id)
        except GeneratedFileError as e:
            failed += 1
            if "cap" in str(e).lower():
                pkg.warnings.append(str(e))
                break
        except Exception:  # noqa: BLE001 — one bad file mustn't sink the import
            # Not the file's name (admin privacy G3).
            logger.exception("flashcards: storing a media file failed")
            await db.rollback()
            failed += 1
    return ids, failed


@router.post("/{file_id}/apkg")
async def import_apkg(
    file_id: uuid.UUID,
    file: UploadFile = File(...),
    media: bool = Form(True),
    history: bool = Form(True),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    _row, doc = await _edit(db, user, file_id)
    settings = dict((doc.data or {}).get("settings") or {})
    tz = service.zone_for(user)
    path = await _save_upload(file)
    try:
        try:
            pkg = await asyncio.to_thread(apkg.read_package, path, settings, tz, history=history)
        except apkg.AnkiError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        ids: dict[str, str] = {}
        failed = 0
        if media and pkg.media_needed:
            ids, failed = await _store_media(db, user, pkg, path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    cards = []
    dropped = 0
    for c in pkg.cards:
        for f in ("front", "back", "note"):
            c[f] = apkg.fill_media(c[f], ids)
        if c["type"] == "cloze":
            try:
                validate_cloze(c["front"])
            except ClozeError:
                dropped += 1
                continue
        elif not c["front"].strip() or not c["back"].strip():
            dropped += 1  # e.g. a card that was only an image we couldn't store
            continue
        cards.append(c)
    missing = sum(1 for n in pkg.media_needed if n not in pkg.media_map)
    return {
        "format": pkg.format,
        "notes": pkg.notes,
        "cards": cards,
        "decks": pkg.decks,
        "logs": _logs_for(pkg.logs, {c["id"] for c in cards}),
        "skipped": pkg.skipped + dropped,
        "truncated": pkg.truncated,
        "history": {"reviews": pkg.reviews_total, "imported": len(pkg.logs), "dropped": pkg.reviews_dropped},
        "media": {"stored": len(ids), "failed": failed, "missing": missing, "requested": bool(media)},
        "warnings": pkg.warnings,
    }


def _logs_for(logs: list[dict], ids: set[str]) -> list[dict]:
    return [e for e in logs if e["c"] in ids]


__all__ = ["router"]

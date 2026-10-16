"""Saving PDFs edited in the viewer, as versions (WP-6.5, Part C §3.9).

The viewer fills in forms, adds highlights, text and drawings, and deletes,
extracts or merges pages — all in the browser (pdf.js). Saving sends the
whole new PDF here:

* the bytes go to a **new** blob in the owner's bucket and the file row
  moves to it; the blob it leaves becomes a ``file_versions`` row
  (``kind='pdf'``, ``source='edit'``, the saver as author) — blobs are never
  overwritten, so a version is just the old path;
* a save based on an older copy than the current one is refused
  (:class:`PdfConflict`) — :func:`revision` names the bytes someone loaded;
* restoring a version points the file back at that version's blob, keeping
  what it replaces as a "Before restoring …" version.

Uploaded PDFs only. A chat-made PDF (``rendered_pdf``) is rebuilt from its
Markdown source, so it isn't edited here.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import FileVersion, UserFile

logger = logging.getLogger("promptly.files.pdf_edit")

Access = Literal["none", "read", "edit"]


class PdfEditError(Exception):
    """The PDF can't be saved (bad bytes, over quota…) — a 400."""


class PdfConflict(Exception):
    """Someone saved the PDF since this copy was loaded — a 409."""


def is_editable_pdf(row: UserFile) -> bool:
    if row.source_kind is not None:
        return False
    name = (row.filename or "").lower()
    return name.endswith(".pdf") or (row.mime_type or "").lower() == "application/pdf"


def revision(row: UserFile) -> str:
    """Names the bytes the file has now — changes with every save."""
    return hashlib.sha256((row.storage_path or "").encode()).hexdigest()[:16]


async def pdf_access(db: AsyncSession, row: UserFile, user) -> Access:  # noqa: ANN001 — User
    """Owner, or a Drive grant that can edit → edit; anyone who can open it
    → read."""
    if row.trashed_at is not None:
        return "none"
    if row.user_id is not None and row.user_id == user.id:
        return "edit"
    from app.files.sharing import caller_grants_for_file, effective_can_edit

    grants = await caller_grants_for_file(db, row, user)
    if grants:
        return "edit" if effective_can_edit(grants) else "read"
    from fastapi import HTTPException

    from app.files.router import _load_readable_file

    try:
        await _load_readable_file(db, row.id, user)
    except HTTPException:
        return "none"
    return "read"


def page_count(data: bytes) -> int:
    """Pages in ``data``; raises :class:`PdfEditError` when it isn't a PDF."""
    if not data.lstrip()[:5] == b"%PDF-":
        raise PdfEditError("That isn't a PDF.")
    try:
        from pypdf import PdfReader

        return len(PdfReader(io.BytesIO(data), strict=False).pages)
    except Exception as exc:  # noqa: BLE001 — pypdf raises broadly
        raise PdfEditError("That PDF couldn't be read.") from exc


def _drop_thumbs(file_id: uuid.UUID) -> None:
    from app.files import storage

    d = storage.UPLOAD_ROOT / "derived" / "thumbs"
    try:
        for p in d.glob(f"{file_id}-*"):
            p.unlink(missing_ok=True)
    except OSError:
        pass


async def _check_quota(db: AsyncSession, row: UserFile, extra: int) -> None:
    from app.auth.models import User
    from app.files.quota import get_quota

    if row.user_id is None:
        return
    owner = await db.get(User, row.user_id)
    if owner is None:
        return
    quota = await get_quota(db, owner)
    # The bytes being replaced stay, as a version — whether they count yet
    # depends on when versions start counting (WP-6.2).
    grow = extra if quota.versions_counted else extra - row.size_bytes
    if quota.cap_bytes is not None and grow > 0 and quota.used_bytes + grow > quota.cap_bytes:
        raise PdfEditError("Saving this would go over the storage limit. Free some space or ask an admin.")


async def _refresh_text(row: UserFile) -> None:
    from app.files.extraction import extract_content_text

    try:
        row.content_text = await asyncio.to_thread(extract_content_text, row)
    except Exception:  # noqa: BLE001 — search must never break a save
        logger.warning("couldn't re-read the text of %s", row.id, exc_info=True)


async def _move_to(db: AsyncSession, row: UserFile, new_path: str, size: int, *, keep: FileVersion) -> None:
    db.add(keep)
    row.storage_path = new_path
    row.size_bytes = size
    await _refresh_text(row)
    await asyncio.to_thread(_drop_thumbs, row.id)


async def save_pdf(db: AsyncSession, row: UserFile, user, data: bytes, *, base: str) -> FileVersion:  # noqa: ANN001
    """Make ``data`` the PDF's content; the current bytes become a version.
    Commits."""
    from app.files.storage import MAX_FILE_BYTES, storage_path_for

    if not is_editable_pdf(row):
        raise PdfEditError("Only an uploaded PDF can be saved here.")
    if len(data) > MAX_FILE_BYTES:
        raise PdfEditError("That PDF is larger than the upload limit.")
    await asyncio.to_thread(page_count, data)
    if base != revision(row):
        raise PdfConflict("Someone saved this PDF after you opened it.")
    await _check_quota(db, row, len(data))

    from app.files import blobstore

    new_path = storage_path_for(row.user_id, uuid.uuid4(), ".pdf")
    staged = await blobstore.put_bytes(new_path, data)
    before = FileVersion(
        file_id=row.id,
        kind="pdf",
        storage_path=row.storage_path,
        size_bytes=row.size_bytes,
        source="edit",
        author_ids=[user.id],
    )
    await _move_to(db, row, new_path, len(data), keep=before)
    blobstore.record(row, staged)
    await db.commit()
    await db.refresh(row)
    return before


async def restore_pdf(db: AsyncSession, row: UserFile, version: FileVersion, user) -> None:  # noqa: ANN001
    """Point the PDF back at ``version``'s bytes, keeping the current ones as
    a version first. Commits."""
    from app.files.storage import absolute_path

    if not version.storage_path or not absolute_path(version.storage_path).exists():
        raise PdfEditError("That version's file is missing.")
    if version.storage_path == row.storage_path:
        return
    stamp = version.created_at.strftime("%d %b %Y %H:%M") if version.created_at else "earlier"
    before = FileVersion(
        file_id=row.id,
        kind="pdf",
        storage_path=row.storage_path,
        size_bytes=row.size_bytes,
        source="restore",
        label=f"Before restoring the version from {stamp}"[:200],
        author_ids=[user.id],
    )
    await _move_to(db, row, version.storage_path, version.size_bytes, keep=before)
    from app.files.blobstore import hash_into

    await hash_into(row)
    await db.commit()


def version_text(storage_path: str | None) -> str:
    """A version's text, one line per text line, with page markers."""
    if not storage_path:
        return ""
    from app.files.prompt import _extract_pdf_text

    try:
        text, _ = _extract_pdf_text(storage_path, 400_000)
    except Exception:  # noqa: BLE001
        return ""
    return text or ""


def version_pages(storage_path: str | None) -> int:
    from app.files.storage import absolute_path

    if not storage_path:
        return 0
    try:
        return page_count(absolute_path(storage_path).read_bytes())
    except (OSError, PdfEditError):
        return 0


__all__ = [
    "PdfConflict",
    "PdfEditError",
    "is_editable_pdf",
    "pdf_access",
    "page_count",
    "restore_pdf",
    "revision",
    "save_pdf",
    "version_pages",
    "version_text",
]

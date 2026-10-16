"""Faithful Office previews (Stage 12, Part C P10) — the bundled ``convert``
service: a Gotenberg container (MIT; LibreOffice inside) turns PowerPoint,
legacy Word/Excel/PowerPoint and OpenDocument files into a PDF, shown by
the PDF viewer instead of a text outline.

On whenever ``CONVERT_URL`` is set — compose starts the ``convert``
service and points the backend at ``http://convert:3000`` by default. The PDF is kept with the file's
other derived files (``derived/<id>/office.pdf``) beside a note of which
bytes it was made from, so a new version is converted again. Conversion
runs on the Arq worker after an upload, or when someone opens the preview
of a file that doesn't have one yet. A legacy file whose text couldn't be
read otherwise gets its text from the PDF (search, RAG, chat).

The converter never sees anything but the one file, and its answer is
only ever served as a PDF to someone who can read the original.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("promptly.files.convert")

# What is converted: presentations and what has no native preview here —
# and Word / Excel too, for their first-page thumbnails in Files.
CONVERT_EXTS = frozenset({".pptx", ".ppt", ".pps", ".ppsx", ".odp", ".doc", ".xls", ".odt", ".ods", ".rtf", ".docx", ".xlsx"})
TIMEOUT_S = 180.0
MAX_BYTES = 100 * 1024 * 1024
PDF_NAME = "office.pdf"
NOTE_NAME = "office.json"
_PENDING = "promptly:convert:pending:{}"


def url() -> str:
    return (os.environ.get("CONVERT_URL") or "").strip().rstrip("/")


def enabled() -> bool:
    return bool(url())


def ext_of(filename: str | None) -> str:
    return os.path.splitext(filename or "")[1].lower()


def convertible(filename: str | None) -> bool:
    return ext_of(filename) in CONVERT_EXTS


def _source_key(row: Any) -> str:
    return f"{row.storage_path}:{row.size_bytes}:{row.content_sha256 or ''}"


def pdf_path(file_id: uuid.UUID | str) -> Path:
    from app.files.derivatives import rendition_path

    return rendition_path(file_id, PDF_NAME)


def ready(row: Any) -> bool:
    """A PDF made from these very bytes is there."""
    from app.files.derivatives import rendition_path

    note = rendition_path(row.id, NOTE_NAME)
    try:
        return pdf_path(row.id).is_file() and json.loads(note.read_text("utf-8")).get("source") == _source_key(row)
    except (OSError, ValueError):
        return False


async def state(row: Any) -> str | None:
    """"ready" | "pending" | "failed" | None (not offered for this file)."""
    import asyncio

    from app.redis_client import redis

    if not enabled() or not convertible(row.filename):
        return None
    if await asyncio.to_thread(ready, row):
        return "ready"
    try:
        got = await redis.get(_PENDING.format(row.id))
    except Exception:  # noqa: BLE001
        got = None
    if got:
        got = got.decode() if isinstance(got, bytes) else got
        return "failed" if got == "failed" else "pending"
    return None


async def request(row: Any) -> str | None:
    """Queue a conversion unless one is ready or on its way. → the state."""
    from app.redis_client import redis

    now = await state(row)
    if now is None and enabled() and convertible(row.filename):
        try:
            await redis.set(_PENDING.format(row.id), "pending", ex=600)
            from app.tasks.queue import enqueue_office_convert

            await enqueue_office_convert(row.id)
        except Exception:  # noqa: BLE001 — a preview never breaks anything
            logger.warning("couldn't queue conversion of %s", row.id, exc_info=True)
            return None
        return "pending"
    return now


async def _post(path: Path, filename: str) -> bytes:
    import httpx

    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        with path.open("rb") as fh:
            r = await client.post(
                f"{url()}/forms/libreoffice/convert",
                files={"files": (filename, fh, "application/octet-stream")},
            )
    if r.status_code != 200 or not r.content.startswith(b"%PDF"):
        raise RuntimeError(f"converter answered {r.status_code}: {r.text[:200]}")
    return r.content


async def convert(file_id: uuid.UUID | str) -> bool:
    """Arq job body: the file → ``office.pdf``. True when made."""
    import asyncio

    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.files.models import UserFile
    from app.files.storage import absolute_path
    from app.redis_client import redis

    fid = uuid.UUID(str(file_id))
    async with SessionLocal() as db:
        row = await db.get(UserFile, fid)
        if row is None or row.trashed_at is not None or not enabled() or not convertible(row.filename):
            return False
        if row.size_bytes and row.size_bytes > MAX_BYTES:
            await redis.set(_PENDING.format(fid), "failed", ex=24 * 3600)
            return False
        src = absolute_path(row.storage_path)
        key = _source_key(row)
        # Converted under a plain name: the converter needn't see the person's.
        name = f"file{ext_of(row.filename)}"
    try:
        pdf = await _post(src, name)
    except Exception:  # noqa: BLE001 — recorded; the text outline stays
        logger.warning("conversion of %s failed", fid, exc_info=True)
        await redis.set(_PENDING.format(fid), "failed", ex=3600)
        return False

    def write() -> None:
        dest = pdf_path(fid)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".tmp")
        tmp.write_bytes(pdf)
        os.replace(tmp, dest)
        rendition_path(fid, NOTE_NAME).write_text(json.dumps({"source": key}), "utf-8")

    await asyncio.to_thread(write)
    await redis.delete(_PENDING.format(fid))
    await _text_from_pdf(fid, pdf)
    return True


async def _text_from_pdf(fid: uuid.UUID, pdf: bytes) -> None:
    """A legacy file's text, read off its PDF when nothing else could."""
    import asyncio
    import io

    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as db:
        row = await db.get(UserFile, fid)
        if row is None or (row.content_text or "").strip():
            return

        def read() -> str:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(pdf))
            parts = []
            for n, page in enumerate(reader.pages[:200], 1):
                parts.append(f"## Page {n}\n{(page.extract_text() or '').strip()}")
            return "\n\n".join(parts).strip()

        try:
            text = await asyncio.to_thread(read)
        except Exception:  # noqa: BLE001
            return
        if text:
            row.content_text = text[:2_000_000]
            await db.commit()


__all__ = ["CONVERT_EXTS", "convert", "convertible", "enabled", "pdf_path", "ready", "request", "state"]

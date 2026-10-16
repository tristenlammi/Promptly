"""First-page thumbnails for Docs and Office files (Files polish), so a folder
of documents reads like a drive rather than a wall of identical icons.

* A **Doc** (TipTap) — its saved HTML snapshot rendered as the PDF export
  does (WeasyPrint, the page's own images inlined), page one as a JPEG.
  Made on the Arq worker, kept in ``derived/thumbs/<id>-doc.jpg`` beside a
  note of which version it shows, and made again when the document
  changes; until then the grid shows the type icon.
* An **Office file** (.pptx, .doc, .xls, OpenDocument…) — page one of the
  PDF the optional converter made (``app.files.convert``); none without it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("promptly.files.doc_thumbs")


def _dir() -> Path:
    from app.files import storage

    return storage.UPLOAD_ROOT / "derived" / "thumbs"


def doc_thumb_path(file_id: uuid.UUID | str) -> Path:
    return _dir() / f"{file_id}-doc.jpg"


def _note_path(file_id: uuid.UUID | str) -> Path:
    return _dir() / f"{file_id}-doc.json"


def version_key(row: Any) -> str:
    """Which version of the document a thumbnail shows."""
    when = getattr(row, "modified_at", None) or getattr(row, "updated_at", None)
    return f"{row.size_bytes}:{when.isoformat() if when else ''}"


def fresh(row: Any) -> bool:
    try:
        return doc_thumb_path(row.id).is_file() and json.loads(_note_path(row.id).read_text("utf-8")).get("v") == version_key(row)
    except (OSError, ValueError):
        return False


async def request(row: Any) -> None:
    """Queue one (deduplicated per version) — never fails the caller."""
    try:
        from app.tasks.queue import enqueue_doc_thumbnail

        await enqueue_doc_thumbnail(row.id, version_key(row))
    except Exception:  # noqa: BLE001
        logger.info("couldn't queue a thumbnail for %s", row.id, exc_info=True)


def _first_page_jpeg(pdf: bytes, width: int = 320) -> bytes:
    import io

    import pypdfium2 as pdfium
    from PIL import Image

    doc = pdfium.PdfDocument(pdf)
    try:
        page = doc[0]
        scale = width / max(1.0, page.get_width())
        img: Image.Image = page.render(scale=scale * 2).to_pil()
    finally:
        doc.close()
    img = img.convert("RGB")
    img.thumbnail((width, width * 2))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=82)
    return out.getvalue()


async def make(file_id: uuid.UUID | str) -> bool:
    """Arq job body: render the Doc's first page. True when made."""
    from app.database import SessionLocal
    from app.files import page_setup
    from app.files.documents_router import _inline_document_images
    from app.files.models import UserFile
    from app.files.pdf_export import build_pdf_html, html_to_pdf
    from app.files.storage import absolute_path

    fid = uuid.UUID(str(file_id))
    async with SessionLocal() as db:
        row = await db.get(UserFile, fid)
        if row is None or row.trashed_at is not None or row.source_kind != "document":
            return False
        key = version_key(row)
        try:
            html_text = await asyncio.to_thread(absolute_path(row.storage_path).read_text, "utf-8")
        except OSError:
            return False
        inlined = await _inline_document_images(db, row, html_text)
    page_html = build_pdf_html(inlined, page_setup.PageSetup(), title="")
    try:
        pdf = await asyncio.to_thread(html_to_pdf, page_html)
        jpeg = await asyncio.to_thread(_first_page_jpeg, pdf)
    except Exception:  # noqa: BLE001 — the icon stays
        logger.warning("thumbnail for document %s failed", fid, exc_info=True)
        return False

    def write() -> None:
        _dir().mkdir(parents=True, exist_ok=True)
        tmp = doc_thumb_path(fid).with_suffix(".tmp")
        tmp.write_bytes(jpeg)
        tmp.replace(doc_thumb_path(fid))
        _note_path(fid).write_text(json.dumps({"v": key}), "utf-8")

    await asyncio.to_thread(write)
    return True


def office_thumb(row: Any) -> bytes | None:
    """Page one of the converter's PDF of an Office file, cached (sync)."""
    from app.files import convert

    if not convert.ready(row):
        return None
    pdf_path = convert.pdf_path(row.id)
    cache = _dir() / f"{row.id}-office-{int(pdf_path.stat().st_mtime)}.jpg"
    try:
        return cache.read_bytes()
    except OSError:
        pass
    data = _first_page_jpeg(pdf_path.read_bytes())
    cache.parent.mkdir(parents=True, exist_ok=True)
    for old in cache.parent.glob(f"{row.id}-office-*.jpg"):
        old.unlink(missing_ok=True)
    cache.write_bytes(data)
    return data


def remove(file_id: uuid.UUID | str) -> None:
    for p in _dir().glob(f"{file_id}-doc.*"):
        p.unlink(missing_ok=True)
    for p in _dir().glob(f"{file_id}-office-*.jpg"):
        p.unlink(missing_ok=True)


__all__ = ["doc_thumb_path", "fresh", "make", "office_thumb", "remove", "request", "version_key"]

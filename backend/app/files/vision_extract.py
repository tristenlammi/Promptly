"""Vision-model text extraction for non-text files (workspace RAG).

Images and scan-only PDFs carry no machine-extractable text, so they fall
straight out of the normal embed pipeline. When the admin has configured a
**Vision relay** model (Admin → Models → Defaults), we reuse it to turn
those files into search-friendly text:

* **Images** (floor plans, product photos, colour selections, screenshots)
  → a thorough vision-model *description* that transcribes any labels and
  describes the layout. The original image still rides the attachment /
  vision path at answer time, so retrieval finds the file by its
  description while the model reasons over the real pixels.
* **Scan-only PDFs** (no embedded text layer) → rasterise each page and
  OCR it through the same relay model.

Entirely optional and self-contained: with **no relay configured** every
function here returns ``None`` and the caller leaves the file unindexed
(exactly the prior behaviour). The relay call cost is bounded — PDFs are
capped at :data:`_MAX_OCR_PAGES` pages — and results are cached upstream by
the file content hash, so a re-pin of an unchanged image is free.
"""
from __future__ import annotations

import io
import logging

from fastapi.concurrency import run_in_threadpool
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.chat.vision_relay import caption_image, caption_index_image_part
from app.files.models import UserFile
from app.files.prompt import _looks_pdf, build_image_part_from_bytes, looks_image
from app.files.storage import absolute_path
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.files.vision_extract")

# Each PDF page is one relay call (latency + cost), so cap how many we OCR.
# A scanned 20-page document is already a generous ceiling for the kinds of
# files users pin to a workspace; beyond that we OCR the first pages and
# stop. (Logged so the truncation is never silent.)
_MAX_OCR_PAGES = 20

# Render scale for pypdfium2. 2.0 ≈ 144 DPI on a standard 72-DPI PDF —
# comfortably legible for OCR without producing needlessly huge bitmaps
# (the vision pipeline downscales to 2048px anyway).
_PDF_RASTER_SCALE = 2.0


def supports_vision_extraction(file: UserFile) -> bool:
    """True when :func:`extract_text_via_vision` could plausibly produce
    text for this file (an image or a PDF). Cheap, MIME/extension only —
    doesn't say whether a relay is configured."""
    return looks_image(file) or _looks_pdf(file)


async def _resolve_relay(
    db: AsyncSession,
) -> tuple[ModelProvider, str] | None:
    """Resolve the admin-configured Vision relay provider + model id.

    Returns ``None`` when the relay isn't configured (or its provider was
    deleted) — the signal to callers that vision extraction is off.
    """
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None or not settings.vision_relay_configured:
        return None
    if settings.vision_relay_model_id is None:
        return None
    provider = await db.get(ModelProvider, settings.vision_relay_provider_id)
    if provider is None:
        return None
    return provider, settings.vision_relay_model_id


async def extract_text_via_vision(
    db: AsyncSession, file: UserFile
) -> str | None:
    """Best-effort text for a non-text file via the Vision relay.

    Returns the extracted text, or ``None`` when the relay isn't
    configured, the file type isn't supported, or extraction failed. Never
    raises — a flaky relay just means the file stays unindexed.
    """
    relay = await _resolve_relay(db)
    if relay is None:
        return None
    provider, model_id = relay

    if looks_image(file):
        result = await caption_image(
            db=db,
            image_file=file,
            relay_provider=provider,
            relay_model_id=model_id,
            for_index=True,
        )
        if result.ok and result.text:
            return f"[Image description — {file.filename}]\n{result.text}"
        logger.info(
            "vision image-describe produced nothing for %s: %s",
            file.id,
            result.error,
        )
        return None

    if _looks_pdf(file):
        return await _ocr_pdf(db, file, provider, model_id)

    return None


def _rasterize_pdf(path: str, max_pages: int) -> tuple[list[bytes], int]:
    """Render up to ``max_pages`` PDF pages to PNG bytes.

    Returns ``(pages, total_pages)`` so the caller can log when it
    truncated. Runs in a worker thread (CPU-bound). pypdfium2 is a
    permissively-licensed (Apache/BSD) pure-wheel binding for PDFium, so
    it adds no system dependencies to the image.
    """
    import pypdfium2 as pdfium

    pages: list[bytes] = []
    pdf = pdfium.PdfDocument(path)
    try:
        total = len(pdf)
        for i in range(min(total, max_pages)):
            page = pdf[i]
            try:
                bitmap = page.render(scale=_PDF_RASTER_SCALE)
                pil_image = bitmap.to_pil()
                buf = io.BytesIO()
                pil_image.save(buf, format="PNG")
                pages.append(buf.getvalue())
            finally:
                page.close()
        return pages, total
    finally:
        pdf.close()


async def _ocr_pdf(
    db: AsyncSession,
    file: UserFile,
    provider: ModelProvider,
    model_id: str,
) -> str | None:
    """OCR a scan-only PDF: rasterise pages, caption each via the relay."""
    path = str(absolute_path(file.storage_path))
    try:
        pages, total = await run_in_threadpool(
            _rasterize_pdf, path, _MAX_OCR_PAGES
        )
    except Exception:  # noqa: BLE001 - pdfium can raise broadly
        logger.exception("pdf rasterisation failed for %s", file.id)
        return None

    if not pages:
        return None
    if total > _MAX_OCR_PAGES:
        logger.info(
            "OCR for %s truncated to first %d of %d pages",
            file.id,
            _MAX_OCR_PAGES,
            total,
        )

    sections: list[str] = []
    for idx, raw in enumerate(pages, start=1):
        part = build_image_part_from_bytes(raw, "image/png")
        if part is None:
            continue
        result = await caption_index_image_part(
            db=db,
            image_part=part,
            relay_provider=provider,
            relay_model_id=model_id,
            label=f"ocr:{file.id}:p{idx}",
        )
        if result.ok and result.text:
            sections.append(f"--- Page {idx} ---\n{result.text}")

    if not sections:
        return None

    note = (
        f"[Scanned PDF OCR — {file.filename}, first {len(pages)} of "
        f"{total} pages]\n"
        if total > _MAX_OCR_PAGES
        else f"[Scanned PDF OCR — {file.filename}]\n"
    )
    return note + "\n\n".join(sections)


__all__ = [
    "extract_text_via_vision",
    "supports_vision_extraction",
]

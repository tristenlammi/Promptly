"""Format uploaded files for inclusion in a chat prompt.

Two output paths, picked per file:

* Text-ish MIME types and PDFs → inlined into the user message body as a
  textual ``<attachment>`` block (see :func:`build_attachment_preamble`).
  This path is used by every model — it's just text in, text out.
* Images → emitted as :class:`~app.models_config.provider.ImagePart`
  entries via :func:`build_image_parts`, which the chat router drops into
  a multimodal ``content`` array for vision-capable models. Non-vision
  models get a textual marker instead and a ``vision_warning`` event so
  the user knows the image bytes weren't actually read.
* Anything else (random binaries) → a one-line placeholder so the model
  at least knows a file by that name was attached.
"""
from __future__ import annotations

import base64
import io
import logging
import os

from app.files.models import UserFile
from app.files.storage import absolute_path, read_text
from app.models_config.provider import ImagePart

logger = logging.getLogger(__name__)

# Per-attachment budget when we inline text content. 64 KB is enough for
# source files, notes, logs and most JSON payloads without blowing up the
# context window.
_TEXT_ATTACHMENT_LIMIT = 64 * 1024

# Hard ceiling on PDF bytes we'll even open — pypdf has to load the whole
# file into memory, and a malicious upload could pin a worker. The upload
# size limit (40 MB) is the real wall; this is just defense-in-depth.
_PDF_PARSE_BYTE_LIMIT = 25 * 1024 * 1024

# MIME types we treat as PDFs.
_PDF_MIMES: frozenset[str] = frozenset({"application/pdf", "application/x-pdf"})

# Image MIME types we'll forward as ImagePart entries to vision models.
# We deliberately exclude SVG (most vision models can't rasterise it) and
# raw camera formats. PNG / JPEG / WebP / GIF / HEIC cover everything users
# actually drop in.
_IMAGE_MIMES: frozenset[str] = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif",
        "image/heic",
        "image/heif",
    }
)
_IMAGE_EXTS: frozenset[str] = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif"}
)

# Cap per-image bytes we actually base64 + ship to the LLM. The upload
# limit (40 MB) covers everything; this is the tighter budget that keeps
# a single multimodal request from blowing up. ~8 MB raw → ~10.7 MB
# base64, which most providers tolerate. Larger images are skipped with
# a warning so the user knows.
_MAX_IMAGE_BYTES = 8 * 1024 * 1024

# MIME types we treat as "text enough to paste into the prompt".
_INLINE_TEXT_MIMES: frozenset[str] = frozenset(
    {
        "application/json",
        "application/xml",
        "application/x-yaml",
        "application/yaml",
        "application/toml",
        "application/x-toml",
        "application/javascript",
        "application/typescript",
        "application/sql",
        "application/x-sh",
        "application/x-python",
    }
)

# Extensions we recognise as source/text even when the MIME sniff was wrong
# (uploads often come in as application/octet-stream when the browser can't
# guess).
_INLINE_TEXT_EXTS: frozenset[str] = frozenset(
    {
        ".txt", ".md", ".markdown", ".rst",
        ".json", ".yml", ".yaml", ".toml",
        ".csv", ".tsv", ".log",
        ".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
        ".go", ".rs", ".rb", ".php", ".java", ".kt", ".swift",
        ".c", ".h", ".cpp", ".hpp", ".cs",
        ".sh", ".bash", ".zsh", ".ps1",
        ".sql", ".html", ".htm", ".css", ".scss", ".less",
        ".xml", ".svg", ".ini", ".cfg", ".env", ".conf", ".gitignore",
    }
)


def _looks_textual(f: UserFile) -> bool:
    mime = (f.mime_type or "").lower()
    if mime.startswith("text/"):
        return True
    if mime in _INLINE_TEXT_MIMES:
        return True
    ext = os.path.splitext(f.filename or "")[1].lower()
    return ext in _INLINE_TEXT_EXTS


def _looks_pdf(f: UserFile) -> bool:
    mime = (f.mime_type or "").lower()
    if mime in _PDF_MIMES:
        return True
    return os.path.splitext(f.filename or "")[1].lower() == ".pdf"


def looks_image(f: UserFile) -> bool:
    """Public predicate — image files are partitioned out of the text
    preamble path by the chat router."""
    mime = (f.mime_type or "").lower()
    if mime in _IMAGE_MIMES:
        return True
    return os.path.splitext(f.filename or "")[1].lower() in _IMAGE_EXTS


def _normalise_image_mime(f: UserFile) -> str:
    """Pick the MIME we'll emit in the data URL.

    Some uploads come in as ``application/octet-stream``; in that case we
    derive a sensible MIME from the extension so the provider doesn't
    reject the data URL.
    """
    mime = (f.mime_type or "").lower()
    if mime in _IMAGE_MIMES:
        # Normalise the alias ``image/jpg`` to the canonical ``image/jpeg``.
        return "image/jpeg" if mime == "image/jpg" else mime
    ext = os.path.splitext(f.filename or "")[1].lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".heic": "image/heic",
        ".heif": "image/heif",
    }.get(ext, "image/png")


def _extract_pdf_text(relative: str, max_bytes: int) -> tuple[str, bool]:
    """Extract text from a PDF on disk.

    Returns ``(text, truncated)``. ``text`` may be empty for encrypted or
    scan-only PDFs — callers should treat empty as "no extractable text".
    Raises ``OSError`` on disk failures and lets pypdf exceptions bubble up
    to the caller, which logs and falls back to a marker.
    """
    path = absolute_path(relative)
    size = path.stat().st_size
    if size > _PDF_PARSE_BYTE_LIMIT:
        logger.warning(
            "skipping PDF text extraction for %s: %d bytes exceeds parse limit",
            relative,
            size,
        )
        return "", False

    # Imported lazily so the rest of the app keeps booting even if pypdf
    # somehow fails to import (missing wheel, etc.).
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    with open(path, "rb") as fh:
        data = fh.read()

    try:
        reader = PdfReader(io.BytesIO(data))
    except PdfReadError as exc:
        logger.warning("pypdf could not parse %s: %s", relative, exc)
        return "", False

    if reader.is_encrypted:
        # Try the empty-password unlock pypdf does automatically; if that
        # didn't work, give up — we don't have credentials.
        try:
            reader.decrypt("")
        except Exception:  # noqa: BLE001 - pypdf raises a grab-bag here
            pass
        if reader.is_encrypted:
            return "", False

    pieces: list[str] = []
    total = 0
    truncated = False
    for idx, page in enumerate(reader.pages, start=1):
        try:
            page_text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 - per-page parse failures
            logger.debug("pypdf page %d of %s failed: %s", idx, relative, exc)
            page_text = ""
        if not page_text.strip():
            continue
        block = f"--- Page {idx} ---\n{page_text.strip()}\n"
        encoded_len = len(block.encode("utf-8"))
        if total + encoded_len > max_bytes:
            remaining = max_bytes - total
            if remaining > 0:
                truncated_block = block.encode("utf-8")[:remaining].decode(
                    "utf-8", errors="ignore"
                )
                pieces.append(truncated_block)
            truncated = True
            break
        pieces.append(block)
        total += encoded_len

    text = "".join(pieces).rstrip()
    if truncated:
        text += "\n… [truncated]"
    return text, truncated


def _human_size(n: float) -> str:
    """Render a byte count as B / KB / MB / GB with one decimal place."""
    val = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if val < 1024 or unit == "GB":
            return f"{val:.0f} {unit}" if unit == "B" else f"{val:.1f} {unit}"
        val /= 1024
    return f"{val:.1f} GB"


def build_attachment_preamble(
    files: list[UserFile], *, vision_handles_images: bool = False
) -> str:
    """Return the text block that should be prepended to the user message.

    ``vision_handles_images`` toggles the marker we emit for image files.
    When True, the chat router is feeding the same image to the model via
    an :class:`ImagePart` so we just acknowledge it ("see attached image
    'foo.png'"); when False we tell the user inline that the model can't
    see the file. Either way images themselves never get base64-encoded
    into the text stream.

    Empty string when there are no attachments.
    """
    if not files:
        return ""

    chunks: list[str] = [
        "The user attached the following file(s) to this message. Use them "
        "as context when composing your reply; content inside "
        "<attachment> tags comes from the file itself.\n"
    ]

    for f in files:
        header = (
            f"<attachment name=\"{f.filename}\" mime=\"{f.mime_type}\" "
            f"size=\"{_human_size(f.size_bytes)}\">"
        )

        if looks_image(f):
            if vision_handles_images:
                body = (
                    f"[Image — {_human_size(f.size_bytes)}. The image bytes "
                    "are provided to you separately as a vision input. "
                    "Refer to it as the attached image when relevant.]"
                )
            else:
                body = (
                    f"[Image — {_human_size(f.size_bytes)}. The current "
                    "model cannot read images, so the visual contents are "
                    "unavailable. The user has been warned.]"
                )
        elif _looks_textual(f):
            try:
                body = read_text(f.storage_path, _TEXT_ATTACHMENT_LIMIT)
            except OSError:
                logger.exception("failed reading attachment %s off disk", f.id)
                body = "[attachment unavailable]"
        elif _looks_pdf(f):
            try:
                extracted, _ = _extract_pdf_text(
                    f.storage_path, _TEXT_ATTACHMENT_LIMIT
                )
            except OSError:
                logger.exception("failed reading PDF attachment %s off disk", f.id)
                extracted = ""
            except Exception:  # noqa: BLE001 - pypdf can raise broadly
                logger.exception("failed extracting PDF text for %s", f.id)
                extracted = ""
            if extracted:
                body = extracted
            else:
                body = (
                    f"[PDF — {_human_size(f.size_bytes)}. No extractable "
                    "text (likely scanned or image-only). Reference it by "
                    "filename if relevant.]"
                )
        else:
            body = (
                f"[Binary file — {_human_size(f.size_bytes)}. Content not "
                "included. Reference it by filename if relevant.]"
            )

        chunks.append(f"{header}\n{body}\n</attachment>")

    chunks.append("")  # trailing newline before the user's own text
    return "\n".join(chunks)


def build_image_parts(
    files: list[UserFile],
) -> tuple[list[ImagePart], list[str]]:
    """Convert every image in ``files`` to an :class:`ImagePart`.

    Returns ``(parts, warnings)``:

    * ``parts`` — one ImagePart per image successfully read off disk.
    * ``warnings`` — human-readable strings (one per image we had to
      skip) so the chat router can forward them to the client. We never
      raise — a busted image just becomes a warning, which is friendlier
      than a 500 mid-stream.
    """
    parts: list[ImagePart] = []
    warnings: list[str] = []

    for f in files:
        if not looks_image(f):
            continue

        if f.size_bytes > _MAX_IMAGE_BYTES:
            warnings.append(
                f"{f.filename!r} is {_human_size(f.size_bytes)} — over the "
                f"{_human_size(_MAX_IMAGE_BYTES)} per-image limit. The model "
                "won't see this image."
            )
            continue

        try:
            path = absolute_path(f.storage_path)
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError:
            logger.exception("failed reading image attachment %s off disk", f.id)
            warnings.append(
                f"{f.filename!r} couldn't be read off disk; the model "
                "won't see it."
            )
            continue

        mime = _normalise_image_mime(f)
        encoded = base64.b64encode(raw).decode("ascii")
        url = f"data:{mime};base64,{encoded}"
        parts.append(ImagePart(url=url, detail="auto"))

    return parts, warnings


__all__ = [
    "build_attachment_preamble",
    "build_image_parts",
    "looks_image",
]

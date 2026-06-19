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

from PIL import Image, UnidentifiedImageError

from app.files.models import UserFile
from app.files.storage import absolute_path, read_text
from app.models_config.provider import ImagePart

logger = logging.getLogger(__name__)

# Per-attachment budget when we inline text content. 64 KB is enough for
# source files, notes, logs and most JSON payloads without blowing up the
# context window.
_TEXT_ATTACHMENT_LIMIT = 64 * 1024

# Hard ceiling on PDF bytes we'll even open — pypdf has to load the whole
# file into memory, and a malicious upload could pin a worker. Matches the
# upload size limit (100 MB) so large-but-legitimate PDFs still get their
# text extracted instead of silently falling back to a filename marker.
_PDF_PARSE_BYTE_LIMIT = 100 * 1024 * 1024

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

# Vision models downsample images to a fixed resolution before they ever
# reach the model, so shipping anything larger is pure wasted payload: it
# inflates the request and, because we re-feed every prior turn's images
# on each new turn, pushes the *aggregate* base64 size toward the
# provider's per-request ceiling (OpenRouter rejects >30 MB of image
# content with a 413). We therefore downscale to this longest edge and
# re-encode to the byte budget below before base64-ing. A side benefit:
# an upload far larger than this still reaches the model (downscaled)
# instead of being dropped.
#
# 2048 px matches GPT-4o's effective ceiling and sits comfortably within
# what Gemini's tiling can use for dense text — higher than Claude's
# 1568 px internal cap, but the extra pixels are cheap (~1 MB/image) and
# benefit the high-res-capable models we actually target. At 2048 px you
# would need ~40+ images in a single conversation to approach the 30 MB
# aggregate limit.
_MAX_IMAGE_EDGE = 2048

# Per-image byte budget for the (possibly downscaled) payload we base64
# and ship. A 1568 px JPEG normally lands well under this; it's a ceiling
# for unusually detailed images, not a typical size.
_PER_IMAGE_TARGET_BYTES = 4 * 1024 * 1024

# Smallest plausible real image. A valid JPEG/PNG/WebP/GIF has a
# multi-byte magic header + palette/IDAT chunks; anything under this is
# definitely corrupted (we've seen phone browsers occasionally upload
# 0-byte or truncated files when the user backgrounds the app mid-upload).
# Shipping a data URL with sub-hundred-byte payload reliably trips the
# "Invalid image data-url" response from Gemini and similar providers,
# so we prefer to drop the attachment with a clear warning.
_MIN_IMAGE_BYTES = 100

# Providers we target (OpenAI / Gemini / Anthropic / OpenRouter OpenAI-
# compat) all accept PNG, JPEG, and WebP. GIF is supported by some
# (OpenAI, OpenRouter) but not Gemini's OpenAI-compat layer, and HEIC is
# rejected by all of them. To avoid a provider-specific 400 we transcode
# anything outside the "universal" set to JPEG before base64-encoding.
_UNIVERSAL_IMAGE_MIMES: frozenset[str] = frozenset(
    {"image/png", "image/jpeg", "image/webp"}
)

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


def _prepare_image_for_vision(raw: bytes, mime: str) -> tuple[bytes, str] | None:
    """Return ``(payload, mime)`` ready to base64 + ship to a vision model.

    Returns ``None`` if Pillow can't decode the bytes at all (truncated
    upload, unsupported format, etc.) so the caller can warn and skip.

    Behaviour:

    * Images already in a universal format (PNG/JPEG/WebP) that fit both
      the dimension cap and the per-image byte budget are returned
      untouched — we don't want to re-compress a crisp screenshot of code
      and introduce JPEG artefacts.
    * Everything else (oversize dimensions, too many bytes, or a non-
      universal format like GIF/BMP/HEIC) is downscaled to
      ``_MAX_IMAGE_EDGE`` and re-encoded as JPEG, stepping quality down
      until it fits ``_PER_IMAGE_TARGET_BYTES``.
    """
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
            width, height = im.size
            longest = max(width, height)

            already_fine = (
                mime in _UNIVERSAL_IMAGE_MIMES
                and len(raw) <= _PER_IMAGE_TARGET_BYTES
                and longest <= _MAX_IMAGE_EDGE
            )
            if already_fine:
                return raw, mime

            # Cap the longest edge, preserving aspect ratio.
            if longest > _MAX_IMAGE_EDGE:
                scale = _MAX_IMAGE_EDGE / longest
                im = im.resize(
                    (max(1, round(width * scale)), max(1, round(height * scale))),
                    Image.LANCZOS,
                )

            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")

            # Step quality down until we fit the budget. A 1568 px JPEG at
            # q85 is normally a few hundred KB, so this rarely iterates
            # past the first pass; the lower steps are a safety net for
            # unusually detailed images.
            data = b""
            for quality in (85, 75, 65, 55):
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=quality, optimize=True)
                data = buf.getvalue()
                if len(data) <= _PER_IMAGE_TARGET_BYTES:
                    break
            # Even at q55 a resized 1568 px image is comfortably under any
            # provider's per-image limit, so ship the smallest we made.
            return data, "image/jpeg"
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("could not prepare image for vision: %s", exc)
        return None


def _image_payload_is_valid(raw: bytes) -> bool:
    """Return True iff Pillow can parse the bytes as a real image.

    A lightweight guard against truncated / corrupted uploads (common
    on flaky mobile connections) that would otherwise produce a
    base64 data URL the provider rejects mid-stream.
    """
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.verify()
        return True
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        return False


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

    Defensive behaviour (tuned for mobile uploads, which fail in more
    exciting ways than desktop drops):

    * empty / truncated files are dropped with a warning rather than
      shipped as an empty ``data:image/jpeg;base64,`` URL (every
      provider rejects that, with Gemini specifically responding
      ``Invalid image data-url``);
    * non-universal formats (GIF, BMP, anything Pillow can open) are
      transcoded to JPEG so all vision providers accept them.
    """
    parts: list[ImagePart] = []
    warnings: list[str] = []

    for f in files:
        if not looks_image(f):
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

        if len(raw) < _MIN_IMAGE_BYTES:
            logger.warning(
                "image %s is %d bytes — dropping to avoid malformed data URL",
                f.id,
                len(raw),
            )
            warnings.append(
                f"{f.filename!r} looks empty or corrupted (only "
                f"{_human_size(len(raw))} on disk). Try attaching it "
                "again — mobile uploads sometimes fail silently when the "
                "app is backgrounded mid-upload."
            )
            continue

        if not _image_payload_is_valid(raw):
            logger.warning(
                "image %s failed Pillow verify; dropping from prompt", f.id
            )
            warnings.append(
                f"{f.filename!r} didn't decode as a valid image. "
                "Try re-saving or re-taking the photo and attaching again."
            )
            continue

        mime = _normalise_image_mime(f)
        # Downscale + re-encode so the payload fits the per-image budget
        # (and transcode non-universal formats like GIF/BMP/HEIC to JPEG).
        # This keeps the aggregate request under the provider's image
        # ceiling and lets oversized uploads through instead of dropping
        # them.
        prepared = _prepare_image_for_vision(raw, mime)
        if prepared is None:
            warnings.append(
                f"{f.filename!r} couldn't be converted to a vision-"
                "friendly format; the model won't see it."
            )
            continue
        payload, mime = prepared

        encoded = base64.b64encode(payload).decode("ascii")
        url = f"data:{mime};base64,{encoded}"
        parts.append(ImagePart(url=url, detail="auto"))

    return parts, warnings


__all__ = [
    "build_attachment_preamble",
    "build_image_parts",
    "looks_image",
]

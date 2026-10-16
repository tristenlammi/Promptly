"""Image codecs Pillow should know about (WP-7.3, Part C §4.4).

Importing this registers pillow-heif's HEIC/HEIF opener (iPhone photos) with
Pillow; AVIF is built into Pillow ≥11.3. Imported by the upload checks, the
vision path and the media extractor, so every process that opens an image —
the API and the worker — can decode them.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("promptly.files.imaging")

HEIF_OK = False
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF_OK = True
except Exception:  # noqa: BLE001 — a missing codec means "no HEIC thumbnails", not a crash
    logger.warning("pillow-heif unavailable — HEIC photos won't decode", exc_info=True)


def avif_ok() -> bool:
    try:
        from PIL import features

        return bool(features.check("avif"))
    except Exception:  # noqa: BLE001
        return False


# Image types a browser can show as-is. Anything else that's an image is
# previewed through the server's renderer (the thumbnail endpoint).
BROWSER_IMAGE_MIMES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"}
)

def to_jpeg_in_place(path, *, quality: int = 90, max_edge: int = 4096) -> None:  # noqa: ANN001 — Path
    """Re-encode an image file as a JPEG, upright, at most ``max_edge`` px
    (no metadata carried over). Raises if Pillow can't decode it."""
    import os

    from PIL import Image, ImageOps

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        im.thumbnail((max_edge, max_edge))
        tmp = f"{path}.jpg.tmp"
        im.save(tmp, format="JPEG", quality=quality, optimize=True)
    os.replace(tmp, path)


__all__ = ["BROWSER_IMAGE_MIMES", "HEIF_OK", "avif_ok", "to_jpeg_in_place"]

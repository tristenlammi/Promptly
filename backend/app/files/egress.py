"""What a photo carries when it leaves Promptly (WP-0.5, decision D13).

Uploads used to be re-encoded to strip EXIF at ingest. That threw away the
original (and its orientation — sideways photos), cost seconds of CPU per
photo, and still left location in places it shouldn't be. The owner's call
(D13): **keep location** for yourself and the people you share with; strip
it where a photo leaves for somewhere you don't control.

So originals are stored byte-exact, and metadata is removed **on egress**:

* public share links (unless that link is set to keep location);
* images sent to an AI provider;
* images pasted into documents (served by a signed URL that outlives
  unsharing, so they're treated as public).

Removal is lossless: ExifTool drops every metadata block (location, camera
serials, timestamps, embedded thumbnails, XMP, IPTC) but keeps orientation
and the colour profile, and the image data is untouched.
"""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from app.files import storage

logger = logging.getLogger("promptly.files.egress")

# Formats ExifTool can rewrite losslessly that we accept as uploads.
STRIPPABLE_MIMES = frozenset(
    {"image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff",
     "image/heic", "image/heif"}
)
_CMD = ["exiftool", "-q", "-q", "-all=", "-tagsfromfile", "@", "-Orientation", "-ICC_Profile"]
_TIMEOUT_S = 30


def strip_bytes(raw: bytes) -> bytes | None:
    """Metadata-free copy of an image's bytes, or None if ExifTool can't
    (unknown format, not installed) — callers then fall back or refuse."""
    try:
        res = subprocess.run(
            [*_CMD, "-", "-o", "-"], input=raw, capture_output=True, timeout=_TIMEOUT_S
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.warning("exiftool unavailable or timed out", exc_info=True)
        return None
    if res.returncode != 0 or not res.stdout:
        logger.warning("exiftool couldn't strip an image: %s", res.stderr[:200])
        return None
    return res.stdout


def strip_file(src: Path, dst: Path) -> bool:
    """Write a metadata-free copy of ``src`` to ``dst`` (atomically)."""
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.unlink(missing_ok=True)
    try:
        res = subprocess.run(
            [*_CMD, "-o", str(tmp), str(src)], capture_output=True, timeout=_TIMEOUT_S
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.warning("exiftool unavailable or timed out", exc_info=True)
        tmp.unlink(missing_ok=True)
        return False
    if res.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        logger.warning("exiftool couldn't strip %s: %s", src.name, res.stderr[:200])
        tmp.unlink(missing_ok=True)
        return False
    os.replace(tmp, dst)
    return True


def strip_in_place(path: Path) -> bool:
    """Replace ``path`` with its metadata-free copy (document images)."""
    return strip_file(path, path)


def public_copy(storage_path: str, mime: str) -> Path | None:
    """Path to a metadata-free copy of a stored image, made once and cached
    next to the uploads (``derived/egress``) keyed by size + mtime, so a
    changed file gets a fresh copy. None when the type isn't strippable
    (serve the original — it carries no photo metadata) or stripping
    failed (the caller refuses rather than leak)."""
    src = storage.absolute_path(storage_path)
    st = src.stat()
    key = f"{storage_path.replace('/', '_')}-{st.st_size}-{st.st_mtime_ns}{src.suffix}"
    out = storage.UPLOAD_ROOT / "derived" / "egress" / key
    if out.exists():
        os.utime(out)  # recently used — keep it past the next prune
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    return out if strip_file(src, out) else None


def prune_cache(max_age_days: int = 30) -> int:
    """Delete cached copies nobody has fetched for ``max_age_days`` (they're
    regenerated on demand). Returns how many were removed."""
    import time

    root = storage.UPLOAD_ROOT / "derived" / "egress"
    if not root.is_dir():
        return 0
    cutoff = time.time() - max_age_days * 86400
    n = 0
    for p in root.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            continue
    return n


__all__ = [
    "STRIPPABLE_MIMES", "prune_cache", "public_copy", "strip_bytes", "strip_file", "strip_in_place",
]

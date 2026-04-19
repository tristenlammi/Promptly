"""Upload safety helpers (Phase 3.1).

Three responsibilities, kept in one file because every uploader call
site needs all three:

1. ``sanitize_filename`` — refuse path separators, null bytes, and
   control characters; strip leading dots; cap length. The cleaned
   name is what we persist on the row + serve back via downloads,
   so it has to be safe both on disk and in a ``Content-Disposition``
   header.
2. ``sniff_and_validate`` — magic-byte sniff the freshly written file
   and reject anything whose true type isn't on the allowlist or
   doesn't match the extension/MIME the browser claimed. Defends
   against ``hello.png`` actually being a PE/ELF binary.
3. ``strip_image_metadata_in_place`` — re-encode JPEG/PNG/WebP/GIF
   uploads to wipe EXIF/GPS. Best-effort; failures don't block the
   upload (the file is already known-good from step 2), they just
   leave the metadata intact and log a warning.

All three are pure-ish (just touch the disk + log) so they can be
called from ``files.router`` without dragging in the DB session.
"""
from __future__ import annotations

import logging
import os
import re
import unicodedata
from pathlib import Path

import filetype
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger("promptly.files.safety")

# --------------------------------------------------------------------
# Allowlist
# --------------------------------------------------------------------
# Every entry is ``ext_with_dot -> (canonical_mime, allowed_aliases)``.
# Aliases cover the "browser sent the slightly-wrong MIME" cases we've
# seen in the wild (Chrome on Windows often ships ``image/jpg`` for
# JPEGs, Firefox ships ``application/x-zip-compressed`` for ``.zip``,
# etc.). Anything not listed here is rejected at the router.
#
# Keep this list small on purpose: every entry expands the attack
# surface for both the LLM (parses the bytes) and the browser (renders
# the download). Adding e.g. ``.html`` would let an admin-uploaded
# shared file XSS every viewer.
_ALLOWED_EXTS: dict[str, tuple[str, frozenset[str]]] = {
    # ----- Images (vision-capable models read these directly) -----
    ".png": ("image/png", frozenset()),
    ".jpg": ("image/jpeg", frozenset({"image/jpg", "image/pjpeg"})),
    ".jpeg": ("image/jpeg", frozenset({"image/jpg", "image/pjpeg"})),
    ".gif": ("image/gif", frozenset()),
    ".webp": ("image/webp", frozenset()),
    ".bmp": ("image/bmp", frozenset({"image/x-bmp", "image/x-ms-bmp"})),
    # ----- Documents (text extracted into the prompt) -----
    ".pdf": ("application/pdf", frozenset({"application/x-pdf"})),
    ".txt": ("text/plain", frozenset({"text/x-log"})),
    ".md": ("text/markdown", frozenset({"text/plain", "text/x-markdown"})),
    ".csv": ("text/csv", frozenset({"text/plain", "application/csv"})),
    ".json": ("application/json", frozenset({"text/plain"})),
    # ----- Source / config snippets the user routinely pastes -----
    ".log": ("text/plain", frozenset()),
    ".yaml": ("text/plain", frozenset({"application/x-yaml", "application/yaml"})),
    ".yml": ("text/plain", frozenset({"application/x-yaml", "application/yaml"})),
    ".xml": ("application/xml", frozenset({"text/xml"})),
    ".html": ("text/html", frozenset({"text/plain"})),
    ".htm": ("text/html", frozenset({"text/plain"})),
}

# MIME types that are allowed to come back from the magic-byte sniffer
# even though we don't know the canonical extension for them. Mostly
# covers the "plain UTF-8 text" case where ``filetype`` returns ``None``
# and we fall back to ``text/plain``.
_TEXT_LIKE_EXTS = frozenset({".txt", ".md", ".csv", ".log", ".json", ".yaml", ".yml", ".xml", ".html", ".htm"})

# Ceiling on the cleaned filename. Long enough for human-readable names,
# short enough to fit comfortably in a ``Content-Disposition`` header
# even after RFC 5987 percent-encoding doubles its size.
_MAX_FILENAME_LEN = 200

# Reserved Windows device names. We sanitise even on Linux because the
# uploader root is sometimes mounted on a Windows host (dev) and we
# don't want a ``CON.txt`` row that explodes when someone clones the
# volume.
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class UnsafeUploadError(ValueError):
    """Raised when a file fails any safety check.

    Carries a ``code`` short-string so the router can audit the
    specific reason without spilling internal detail into the 4xx
    response body.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------
# Filename hardening
# --------------------------------------------------------------------
# Match every C0 + C1 control character + the obvious shell + path
# trouble bytes. ``\x7f`` is DEL, included because some legacy clients
# embed it as a soft-delete marker.
_CONTROL_OR_PATHY = re.compile(
    r"[\x00-\x1f\x7f-\x9f/\\:*?\"<>|]"
)
# Collapse runs of whitespace so "evil   .pdf" doesn't render as a
# spoofed double-extension after sanitisation.
_RUNS_OF_WS = re.compile(r"\s+")


def sanitize_filename(raw: str | None) -> str:
    """Return a safe display-name for an uploaded file.

    Behaviour:

    * Strips directory components — only the basename survives. We
      never trust the client to send "documents/x.pdf" and DTRT.
    * Normalises Unicode to NFC so visually-identical bytes don't
      slip past the dedup / collision detection that sometimes runs
      on top of this.
    * Removes control + path-separator + shell-special characters.
    * Collapses runs of whitespace.
    * Forbids leading dots (so the file isn't hidden on Linux and
      can't accidentally land as a dotfile in the upload bucket).
    * Strips a trailing dot or space (Windows silently does this when
      it opens the file, which is a known spoofing vector).
    * Refuses Windows reserved device names regardless of extension.
    * Caps length to ``_MAX_FILENAME_LEN`` *after* cleaning so a
      pathological input can't slip an attack past us by being long
      enough to truncate the malicious bit off-screen in the UI.

    Raises ``UnsafeUploadError`` instead of silently producing
    ``""`` so callers can audit the rejection.
    """
    if raw is None or raw == "":
        raise UnsafeUploadError("bad_filename", "Filename is required")

    # NFC over NFD/NFKC: NFD splits combining chars (so ``é`` becomes
    # two code points), NFKC rewrites compatibility chars (so ``ﬁ``
    # becomes ``fi``). NFC is the lossless one — it just composes
    # already-equivalent forms.
    name = unicodedata.normalize("NFC", raw)

    # Strip directories. We do this *after* normalising because
    # NFC could in theory introduce code points that ``os.path``
    # interprets differently across platforms.
    name = os.path.basename(name)
    # ntpath-style backslash separators show up on Windows uploads
    # even though ``os.path.basename`` on Linux doesn't strip them.
    name = name.rsplit("\\", 1)[-1]

    # Replace, don't drop. Keeping a placeholder makes it obvious to
    # the user (and to anyone reviewing the audit) that the filename
    # was modified.
    name = _CONTROL_OR_PATHY.sub("_", name)
    name = _RUNS_OF_WS.sub(" ", name).strip()

    # Trailing dot/space → strip. Leading dots → also strip (we don't
    # want hidden files in the upload bucket).
    name = name.rstrip(". ")
    name = name.lstrip(".")

    if not name:
        raise UnsafeUploadError("bad_filename", "Filename reduces to empty after sanitization")

    stem, ext = os.path.splitext(name)
    if stem.upper() in _WINDOWS_RESERVED:
        raise UnsafeUploadError(
            "bad_filename",
            f"Filename {raw!r} uses a reserved system name",
        )

    if len(name) > _MAX_FILENAME_LEN:
        # Truncate the *stem*, not the extension — the extension is
        # what downstream allowlist checks key off.
        keep = _MAX_FILENAME_LEN - len(ext)
        if keep < 1:
            raise UnsafeUploadError(
                "bad_filename",
                "Filename extension alone exceeds the maximum length",
            )
        name = stem[:keep] + ext

    return name


# --------------------------------------------------------------------
# Magic-byte sniffing
# --------------------------------------------------------------------
def _ext_lower(filename: str) -> str:
    return os.path.splitext(filename)[1].lower()


def is_extension_allowed(filename: str) -> bool:
    """True if ``filename``'s extension is in the upload allowlist."""
    return _ext_lower(filename) in _ALLOWED_EXTS


def canonical_mime_for(filename: str) -> str:
    """Return the canonical MIME for an allowlisted filename.

    Caller must have already passed ``is_extension_allowed``. Raises
    ``KeyError`` otherwise (programmer error, not user input).
    """
    return _ALLOWED_EXTS[_ext_lower(filename)][0]


def sniff_and_validate(
    path: Path,
    *,
    declared_filename: str,
    declared_mime: str | None,
) -> str:
    """Magic-byte sniff ``path`` and return the canonical MIME.

    Raises ``UnsafeUploadError`` if:

    * The extension isn't on the allowlist.
    * The browser-declared MIME isn't a match for the extension.
    * The actual bytes look like a different file format than the
      extension claims.

    The return value is the canonical MIME we should persist on the
    DB row — never trust the browser-declared one for storage, even
    after a successful sniff.
    """
    ext = _ext_lower(declared_filename)
    if ext not in _ALLOWED_EXTS:
        raise UnsafeUploadError(
            "bad_extension",
            f"Files of type {ext or '(none)'!r} are not allowed",
        )

    canonical, aliases = _ALLOWED_EXTS[ext]

    # MIME alias check (browser claim vs. allowlist).
    if declared_mime:
        claim = declared_mime.split(";", 1)[0].strip().lower()
        # ``application/octet-stream`` is the universal "I dunno"; we
        # tolerate it because the magic-byte sniff below will catch
        # any actual mismatch.
        if claim and claim != "application/octet-stream":
            allowed = {canonical} | aliases
            if claim not in allowed:
                raise UnsafeUploadError(
                    "mime_mismatch",
                    f"Declared content type {declared_mime!r} doesn't match "
                    f"file extension {ext!r}",
                )

    # Magic-byte sniff. ``filetype`` returns ``None`` for plain text /
    # markdown / etc. — the library only knows binary signatures —
    # which is fine for our text-like extensions and a hard fail for
    # anything else.
    try:
        kind = filetype.guess(str(path))
    except Exception as e:  # noqa: BLE001 — defensive: filetype is third-party
        logger.warning("filetype.guess raised on %s: %s", path, e)
        kind = None

    if kind is None:
        if ext in _TEXT_LIKE_EXTS:
            return canonical
        raise UnsafeUploadError(
            "mime_mismatch",
            f"Could not verify the contents of the uploaded file as {canonical}",
        )

    sniffed_mime = (kind.mime or "").lower()
    sniffed_ext = f".{kind.extension}".lower() if kind.extension else ""

    # Treat the canonical + alias set as our truth on the wire.
    allowed = {canonical} | aliases
    if sniffed_mime not in allowed and sniffed_ext != ext:
        # Special-case the common JPEG aliasing one more time: the
        # magic-byte sniffer always returns ``image/jpeg`` for both
        # ``.jpg`` and ``.jpeg``, but if someone uploaded ``foo.png``
        # that's actually a JPEG, we want to reject it because the
        # browser will mis-render it.
        raise UnsafeUploadError(
            "mime_mismatch",
            f"File contents look like {sniffed_mime or 'unknown'!r}, "
            f"but the filename claims {canonical!r}",
        )

    return canonical


# --------------------------------------------------------------------
# EXIF stripping
# --------------------------------------------------------------------
# Pillow needs a hint at the output format if we want lossless behaviour
# for the formats that have a lossy default.
_PIL_FORMAT_BY_EXT: dict[str, str] = {
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".png": "PNG",
    ".gif": "GIF",
    ".webp": "WEBP",
    ".bmp": "BMP",
}

# Save kwargs per format. We pick "preserve quality, drop metadata"
# everywhere — the user uploaded a photo, they didn't ask us to
# recompress it, but they certainly don't expect us to leak GPS.
_PIL_SAVE_KWARGS: dict[str, dict[str, object]] = {
    "JPEG": {"quality": "keep", "optimize": False, "progressive": False},
    "PNG": {"optimize": False},
    "GIF": {"save_all": True},
    "WEBP": {"quality": 95, "method": 4, "lossless": False},
    "BMP": {},
}


def strip_image_metadata_in_place(path: Path, canonical_mime: str) -> None:
    """Re-encode an image at ``path`` to drop EXIF / GPS / IPTC.

    Best-effort: a failure here logs a warning but does NOT raise.
    We've already proven the file is a real image of the claimed type
    via ``sniff_and_validate``, so the worst case of a crash here is
    that a few bytes of metadata stay on disk — annoying, not unsafe.
    """
    if not canonical_mime.startswith("image/"):
        return

    ext = path.suffix.lower()
    fmt = _PIL_FORMAT_BY_EXT.get(ext)
    if fmt is None:
        return

    save_kwargs = dict(_PIL_SAVE_KWARGS.get(fmt, {}))

    try:
        with Image.open(path) as im:
            # Force a load before we touch the bytes on disk so the
            # subsequent ``save`` doesn't read from a half-closed
            # handle on Windows.
            im.load()

            # Build a fresh image with no ``info`` dict — that's the
            # bag Pillow stashes EXIF/IPTC/XMP into. ``copy()`` makes
            # an in-memory pixel-perfect duplicate; the new image's
            # ``info`` is empty by default.
            scrubbed = im.copy()

            # Animated GIFs / multi-frame TIFFs lose their extra
            # frames on plain ``copy()``. We only handle GIFs here
            # because the rest of the allowlist is single-frame.
            if fmt == "GIF" and getattr(im, "is_animated", False):
                # Re-save every frame so we don't silently truncate a
                # multi-frame GIF down to its first frame.
                save_kwargs["save_all"] = True
                save_kwargs["append_images"] = [
                    f.copy() for f in _iter_frames(im)
                ]

            # ``exif=b""`` wipes EXIF on JPEG even when the format
            # would otherwise carry it across via ``info``. Pillow
            # ignores the kwarg silently for formats that don't
            # support EXIF (PNG/GIF/BMP), so it's safe to pass
            # universally.
            scrubbed.save(path, format=fmt, exif=b"", **save_kwargs)
    except (UnidentifiedImageError, OSError, ValueError) as e:
        logger.warning(
            "EXIF strip failed for %s (%s); leaving original bytes in place: %s",
            path,
            canonical_mime,
            e,
        )


def _iter_frames(im: Image.Image):
    """Yield every frame after the first for an animated image."""
    try:
        n = im.n_frames
    except Exception:  # noqa: BLE001 — Pillow may raise here on some formats
        return
    for i in range(1, n):
        try:
            im.seek(i)
        except EOFError:
            return
        yield im.copy()


__all__ = [
    "UnsafeUploadError",
    "canonical_mime_for",
    "is_extension_allowed",
    "sanitize_filename",
    "sniff_and_validate",
    "strip_image_metadata_in_place",
]

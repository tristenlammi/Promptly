"""Signed media URLs (WP-7.5, Part C §4.6).

The API authenticates with a bearer header, which ``<img>`` and ``<video>``
can't send — so every thumbnail, preview and video used to be fetched over
XHR into a blob, with no Range (no seeking), no browser caching across
pages and a 30-second timeout on big downloads (R-048, R-094).

Now whoever may read a file gets short-lived links to its bytes:

    /m/<token>

The token names the file, the rendition (``thumb``, ``preview``,
``poster``, ``video`` or ``original``), the user it was issued to (with
their ``token_version``, so signing out everywhere ends it), an expiry and
a version tag (so a changed file gets a new URL and never a stale cached
one). It's an HMAC with a key derived from ``SECRET_KEY`` by HKDF for this
one purpose — a media link can't be turned into anything else.

Serving re-checks that the user may still read the file (an unshare takes
effect at once) and then hands the bytes to nginx with ``X-Accel-Redirect``
to an ``internal`` location over a read-only mount: Range/206 for seeking,
sendfile, and no bytes through the single uvicorn worker. Without nginx
(tests, a bare backend) the backend streams them itself, with Range.

Expiry is rounded to a window, so the same file gets the same URL for a
few hours and the browser cache keeps working across page loads.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time
import uuid
import zlib
from dataclasses import dataclass

from app.config import get_settings

settings = get_settings()

_VERSION = 1
_INFO = b"promptly/media-url/v1"
# A link lives 3–6 hours: issued for the current 3-hour window plus the next.
WINDOW_SECONDS = 3 * 3600

RENDITIONS = ("thumb", "preview", "poster", "video", "original")
# A zip download (WP-7.6): the "file" is the zip job. A version of an
# uploaded file (WP-8.1): the "file" is the version. A part of a library
# export (WP-10.4): the "file" is the export, ``ver`` the part number. A face
# or animal's crop (PH-3): the "file" is the face (or animal). An edited
# photo's tile and preview (PH-7). New codes only ever go on the end.
_CODE = {name: i + 1 for i, name in enumerate((*RENDITIONS, "zip", "version", "export", "face", "thumb_edit", "preview_edit"))}
_NAME = {v: k for k, v in _CODE.items()}
# What each rendition is on disk under derived/<file_id>/.
RENDITION_FILE = {
    "thumb": "thumb.webp",
    "preview": "preview.webp",
    "poster": "poster.webp",
    "video": "video.mp4",
    "thumb_edit": "thumb.edit.webp",
    "preview_edit": "preview.edit.webp",
}
_EDITED = {"thumb": "thumb_edit", "preview": "preview_edit"}


def shown(renditions: dict | None, rendition: str) -> tuple[str, str, dict] | None:
    """The rendition a person sees — an edited photo's edited tile or
    preview (PH-7) — as (code, file name, info); None if not made yet."""
    r = renditions or {}
    alt = _EDITED.get(rendition)
    if alt and r.get(RENDITION_FILE[alt]):
        return alt, RENDITION_FILE[alt], r[RENDITION_FILE[alt]]
    name = RENDITION_FILE[rendition]
    return (rendition, name, r[name]) if r.get(name) else None


def sign_shown(file_id: uuid.UUID, user_id: uuid.UUID, token_version: int, renditions: dict | None, rendition: str) -> str | None:
    """A link to what's shown for this rendition, or None."""
    got = shown(renditions, rendition)
    if got is None:
        return None
    code, name, info = got
    return sign(file_id, user_id, token_version, code, rendition_tag(name, info))

_PAYLOAD = struct.Struct(">BBI16s16sII")  # version, rendition, exp, file, user, tv, ver


def _hkdf(secret: str) -> bytes:
    """RFC 5869 HKDF-SHA256 (one block): a key for media links only."""
    prk = hmac.new(b"promptly-media", secret.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(prk, _INFO + b"\x01", hashlib.sha256).digest()


def _keys() -> list[bytes]:
    keys = [_hkdf(settings.SECRET_KEY)]
    if settings.SECRET_KEY_PREVIOUS:
        # Links issued just before a key rotation keep working until they
        # expire, like sessions do.
        keys.append(_hkdf(settings.SECRET_KEY_PREVIOUS))
    return keys


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def version_tag(*parts: object) -> int:
    """A 32-bit tag that changes when the bytes behind a URL do."""
    return zlib.crc32(":".join(str(p) for p in parts).encode("utf-8")) & 0xFFFFFFFF


def rendition_tag(name: str, info: dict) -> int:
    """The version tag of a rendition: the file it is and its size (made
    again → a new size, near enough always)."""
    return version_tag(name, info.get("bytes"))


def expiry(now: float | None = None) -> int:
    now = time.time() if now is None else now
    return (int(now) // WINDOW_SECONDS + 2) * WINDOW_SECONDS


@dataclass(frozen=True)
class MediaClaim:
    file_id: uuid.UUID
    user_id: uuid.UUID
    rendition: str
    token_version: int
    exp: int
    ver: int


def sign(file_id: uuid.UUID, user_id: uuid.UUID, token_version: int, rendition: str, ver: int, *, now: float | None = None) -> str:
    payload = _PAYLOAD.pack(
        _VERSION, _CODE[rendition], expiry(now), file_id.bytes, user_id.bytes,
        int(token_version) & 0xFFFFFFFF, ver & 0xFFFFFFFF,
    )
    mac = hmac.new(_keys()[0], payload, hashlib.sha256).digest()[:16]
    return f"/m/{_b64(payload + mac)}"


def verify(token: str, *, now: float | None = None) -> MediaClaim | None:
    """The claim a token carries, or None if it's forged, mangled or
    expired. (Whether the user may still read the file is the caller's
    check.)"""
    try:
        raw = _unb64(token)
    except (ValueError, TypeError):
        return None
    if len(raw) != _PAYLOAD.size + 16:
        return None
    payload, mac = raw[: _PAYLOAD.size], raw[_PAYLOAD.size :]
    if not any(hmac.compare_digest(hmac.new(k, payload, hashlib.sha256).digest()[:16], mac) for k in _keys()):
        return None
    version, code, exp, fid, uid, tv, ver = _PAYLOAD.unpack(payload)
    if version != _VERSION or code not in _NAME:
        return None
    if exp < (time.time() if now is None else now):
        return None
    return MediaClaim(uuid.UUID(bytes=fid), uuid.UUID(bytes=uid), _NAME[code], tv, exp, ver)


__all__ = [
    "MediaClaim", "RENDITIONS", "RENDITION_FILE", "WINDOW_SECONDS", "expiry", "rendition_tag", "shown", "sign", "sign_shown", "verify",
    "version_tag",
]

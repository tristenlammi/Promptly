"""Profile pictures + initials-chip colours.

Storage: one processed image per user at ``avatars/<user_id>.webp``
under the upload root (square-cropped, resized, EXIF-normalised at
upload time, so serving is a dumb file read).

Serving: ``<img src>`` can't attach an Authorization header, so avatar
URLs follow the Drive-document inline-asset pattern — an HMAC over
``"avatar:<user_id>"`` rides in the query string as the credential.
The signature is deliberately stable (no version inside the HMAC): it
grants "may view this user's avatar", which every authenticated user
has anyway; the separate ``v=`` timestamp param only busts caches when
the picture changes. Rotate ``SECRET_KEY`` to revoke everything.

Colour: ``avatar_color`` (user-chosen) with a deterministic palette
hash as the fallback — the *same* palette + hash the collab cursors
use, so a user's chip colour matches their cursor everywhere.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import uuid
from datetime import datetime, timezone
from pathlib import Path

from typing import TYPE_CHECKING

from app.config import get_settings
from app.files.storage import absolute_path

if TYPE_CHECKING:  # imported lazily elsewhere to avoid a models cycle
    from app.auth.models import User

# Mirrors the collab palettes in documents_router / canvas_router so a
# user's default chip colour matches their cursor colour.
AVATAR_COLOR_PALETTE = [
    "#D97757",  # brand accent
    "#4F46E5",  # indigo
    "#0EA5E9",  # sky
    "#10B981",  # emerald
    "#F59E0B",  # amber
    "#EF4444",  # red
    "#A855F7",  # purple
    "#14B8A6",  # teal
]

AVATAR_SIZE = 256  # square edge, px
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


def default_color_for_user(user_id: uuid.UUID) -> str:
    return AVATAR_COLOR_PALETTE[user_id.int % len(AVATAR_COLOR_PALETTE)]


def effective_color(user: "User") -> str:
    """The colour every chip/cursor should use for this user."""
    return user.avatar_color or default_color_for_user(user.id)


def avatar_rel_path(user_id: uuid.UUID) -> str:
    return f"avatars/{user_id}.webp"


def avatar_abs_path(user_id: uuid.UUID) -> Path:
    return absolute_path(avatar_rel_path(user_id))


def _signature(user_id: uuid.UUID) -> str:
    message = f"avatar:{user_id}".encode("utf-8")
    return hmac.new(
        get_settings().SECRET_KEY.encode("utf-8"), message, hashlib.sha256
    ).hexdigest()


def verify_signature(user_id: uuid.UUID, signature: str) -> bool:
    return hmac.compare_digest(_signature(user_id), signature)


def avatar_url_for(user: "User") -> str | None:
    """Signed, cache-busting URL for the user's picture; None = no picture."""
    if user.avatar_updated_at is None:
        return None
    version = int(user.avatar_updated_at.timestamp())
    return f"/api/auth/avatar/{user.id}?sig={_signature(user.id)}&v={version}"


def process_and_store(user: "User", raw: bytes) -> datetime:
    """Normalise an uploaded image and write it to the avatar slot.

    EXIF-rotates, flattens alpha onto the app background, centre-crops
    square, resizes to ``AVATAR_SIZE`` and saves WEBP. Raises
    ``ValueError`` with a user-safe message on anything unreadable.
    """
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError("That file doesn't look like a readable image.") from e

    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    if img.mode == "RGBA":
        # Flatten transparency onto neutral dark — avatars render on
        # both themes, and WEBP keeps alpha anyway; flattening avoids
        # odd halos from premultiplied edges in some browsers.
        background = Image.new("RGB", img.size, "#2A2622")
        background.paste(img, mask=img.split()[-1])
        img = background

    img = ImageOps.fit(img, (AVATAR_SIZE, AVATAR_SIZE), Image.Resampling.LANCZOS)

    path = avatar_abs_path(user.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="WEBP", quality=85, method=4)

    now = datetime.now(timezone.utc)
    user.avatar_updated_at = now
    return now


def remove_avatar(user: "User") -> None:
    try:
        avatar_abs_path(user.id).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass  # best-effort; the DB flag is the source of truth
    user.avatar_updated_at = None

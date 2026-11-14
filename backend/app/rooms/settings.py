"""Rooms' server-wide settings: what Admin → Rooms shows.

They live in one JSON object, ``app_settings.rooms_settings``, so adding a
switch needs no migration.

**To add a setting**

1. Add a line to :data:`SETTINGS` below: its key, its default and what kind
   of value it is (``Bool``, ``Int(lo, hi)`` or ``Choice(...)``).
2. Read it where it matters: ``(await settings.load(db))["your_key"]``.
3. Add a row for it to ``ROWS`` in
   ``frontend/src/components/admin/RoomsPanel.tsx`` (its key, label and
   help text); the panel draws the right control from the kind.

Nothing else: the admin API (``admin_router.py``) reads and saves every key
listed here, and refuses any other.

The GIF library's key is the one secret. It is not in the JSON: it's
``app_settings.rooms_gif_key_encrypted`` (Fernet), and the admin API only
ever says whether one is stored.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.rooms.settings")


@dataclass(frozen=True)
class Bool:
    default: bool
    kind: str = "bool"

    def clean(self, v: Any) -> bool:
        if not isinstance(v, bool):
            raise ValueError("on or off")
        return v


@dataclass(frozen=True)
class Int:
    default: int
    lo: int
    hi: int
    kind: str = "int"

    def clean(self, v: Any) -> int:
        if isinstance(v, bool) or not isinstance(v, int) or not (self.lo <= v <= self.hi):
            raise ValueError(f"a whole number from {self.lo} to {self.hi}")
        return v


@dataclass(frozen=True)
class Choice:
    default: str
    choices: tuple[str, ...]
    kind: str = "choice"

    def clean(self, v: Any) -> str:
        if v not in self.choices:
            raise ValueError("one of " + ", ".join(self.choices))
        return v


# Every server-wide Rooms setting. Keep the keys short and plain: they're
# what the admin page and the code both use.
SETTINGS: dict[str, Bool | Int | Choice] = {
    # ---- GIF search (a library outside this server) ----
    # On only does anything once a key is stored.
    "gif_search": Bool(False),
    "gif_provider": Choice("giphy", ("giphy", "klipy")),
    # How strict the library is asked to be: family (GIPHY g / KLIPY high),
    # teen (pg-13 / medium), all (r / off).
    "gif_rating": Choice("teen", ("family", "teen", "all")),
    # ---- Link previews ----
    "link_previews": Bool(True),
    # ---- Custom emoji ----
    "emoji_max_per_space": Int(100, 0, 500),
    "emoji_max_kb": Int(512, 32, 2048),
    # ---- Add new settings below this line (voice messages, polls,
    #      read receipts…). See the three steps at the top of this file. ----
}


def defaults() -> dict[str, Any]:
    return {k: s.default for k, s in SETTINGS.items()}


def describe() -> dict[str, dict[str, Any]]:
    """Each setting's kind and limits, for the admin page's controls."""
    out: dict[str, dict[str, Any]] = {}
    for k, s in SETTINGS.items():
        d: dict[str, Any] = {"kind": s.kind, "default": s.default}
        if isinstance(s, Int):
            d.update({"min": s.lo, "max": s.hi})
        if isinstance(s, Choice):
            d["choices"] = list(s.choices)
        out[k] = d
    return out


def _merged(stored: Any) -> dict[str, Any]:
    out = defaults()
    if isinstance(stored, dict):
        for k, v in stored.items():
            spec = SETTINGS.get(k)
            if spec is None:
                continue
            try:
                out[k] = spec.clean(v)
            except ValueError:
                pass  # an old or hand-edited value: the default stands
    return out


async def _row(db: AsyncSession, *, create: bool = False):  # noqa: ANN202
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None and create:
        # Seeded by a migration and at every start; this is the last guard.
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
        await db.flush()
    return row


async def load(db: AsyncSession) -> dict[str, Any]:
    """Every setting, with defaults for the ones never changed."""
    row = await _row(db)
    return _merged(getattr(row, "rooms_settings", None))


def clean_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """Validate a change. Raises ``ValueError("key: why")``."""
    out: dict[str, Any] = {}
    for k, v in patch.items():
        spec = SETTINGS.get(k)
        if spec is None:
            raise ValueError(f"{k}: not a Rooms setting")
        try:
            out[k] = spec.clean(v)
        except ValueError as e:
            raise ValueError(f"{k}: {e}") from e
    return out


async def save(db: AsyncSession, patch: dict[str, Any]) -> dict[str, Any]:
    """Apply a validated change (the caller commits)."""
    row = await _row(db, create=True)
    cur = _merged(row.rooms_settings)
    cur.update(clean_patch(patch))
    row.rooms_settings = cur  # reassigned so the JSONB change is saved
    return cur


# ------------------------------------------------------------------ the GIF key


async def gif_key(db: AsyncSession) -> str | None:
    from app.auth.utils import decrypt_secret

    row = await _row(db)
    enc = getattr(row, "rooms_gif_key_encrypted", None)
    if not enc:
        return None
    try:
        return decrypt_secret(enc) or None
    except Exception:  # noqa: BLE001 - an unreadable key is the same as none
        logger.warning("The stored GIF key couldn't be read")
        return None


async def gif_search(db: AsyncSession) -> dict[str, str] | None:
    """What a signed-in person's page needs to search the GIF library, or
    None when search is off or has no key.

    The key is in it. GIPHY's and KLIPY's terms both require searches and
    GIFs to go straight from the person's browser to the library (no
    proxying, no copies kept here), so the browser has to hold the key, as
    it does in every app that uses them. It is given to signed-in people
    only, and only while search is on."""
    s = await load(db)
    if not s["gif_search"]:
        return None
    key = await gif_key(db)
    if not key:
        return None
    return {"provider": s["gif_provider"], "key": key, "rating": s["gif_rating"]}

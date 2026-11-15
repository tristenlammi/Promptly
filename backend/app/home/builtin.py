"""This server's own home box.

Promptly's own deployment bundles Home Assistant and the connector
(docker-compose.yml, "Promptly Home"). That box needs no preparing, no setup
string and no claim code: it proves itself with ``HOME_BOX_SECRET``, a value
the install and update scripts generate into ``.env`` and nobody is shown,
and it always has the same id (:data:`BOX_ID`).

When an admin turns Promptly Home on, the box goes straight into a home that
admin owns ("Home"); they add the rest of the household from Home settings.
From then on it's a home like any other: its members see it, and nobody else
does, other admins included.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.config import get_settings

from . import codes
from .models import Home, HomeBox, HomeMember

logger = logging.getLogger("promptly.home.builtin")

# The same on every server: there is at most one built-in box.
BOX_ID = uuid.UUID("b0000000-0000-4000-8000-00000000b0c5")
LABEL = "This server's own box"
HOME_NAME = "Home"


def secret() -> str:
    return (getattr(get_settings(), "HOME_BOX_SECRET", None) or "").strip()


def deployed() -> bool:
    """Is Home Assistant bundled with this deployment? The scripts make the
    secret when they turn the two containers on; someone who later takes the
    ``home`` token out of COMPOSE_PROFILES (which the backend sees, through
    .env) has left it out, whatever the secret says."""
    if len(secret()) < 16:
        return False
    profiles = os.environ.get("COMPOSE_PROFILES")
    if profiles is None:
        return True
    return any(p.strip() in ("home", "home-desktop") for p in profiles.split(","))


def is_builtin(box_id: uuid.UUID | None) -> bool:
    return box_id == BOX_ID


def key_ok(key: str) -> bool:
    return deployed() and codes.same(codes.digest(key), codes.digest(secret()))


async def ensure_box(db: AsyncSession) -> HomeBox:
    """The built-in box's row, made on first need. Its stored key hash
    follows the secret, so a regenerated secret just works."""
    box = await db.get(HomeBox, BOX_ID)
    want = codes.digest(secret())
    if box is None:
        box = HomeBox(id=BOX_ID, label=LABEL, key_hash=want, claim_hash=None)
        db.add(box)
        await db.flush()
    elif box.key_hash != want:
        box.key_hash = want
    if box.revoked_at is not None:
        box.revoked_at = None  # it can't be cut off: it's part of the server
    return box


async def _first_admin(db: AsyncSession) -> User | None:
    return (await db.execute(select(User).where(User.role == "admin").order_by(User.created_at).limit(1))).scalar_one_or_none()


async def ensure_home(db: AsyncSession, owner: User | None = None) -> Home | None:
    """Put the built-in box in a home, if it isn't in one. ``owner`` is the
    admin who turned Home on; without one (Home was already on when the box
    first dialled in) it's the server's first admin. Commits nothing."""
    box = await ensure_box(db)
    if box.home_id is not None:
        return await db.get(Home, box.home_id)
    owner = owner or await _first_admin(db)
    if owner is None:
        return None
    home = Home(name=HOME_NAME, owner_id=owner.id)
    db.add(home)
    await db.flush()
    db.add(HomeMember(home_id=home.id, user_id=owner.id, role="owner"))
    box.home_id = home.id
    box.claimed_by = owner.id
    box.claimed_at = datetime.now(timezone.utc)
    box.snapshot = None
    logger.info("the built-in home box is now in a home owned by %s", owner.username)
    return home

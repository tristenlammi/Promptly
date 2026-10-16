"""The family library (PH-5, Part E §E5): people on this server pooling
photos — like a shared library, but each member decides what goes in.

* A **family** has an owner and members (one family per person). The owner
  names it and adds or removes people; anyone can leave.
* Each member's **share**: ``none`` (the default — joining shares nothing),
  ``all`` (their whole Photos library), ``since`` (taken on or after a
  date) or ``people`` (photos with any of these people of theirs).
* What's in is kept in ``photo_family_items`` — refreshed when a share
  changes, and every few minutes as photos arrive (the understanding tick)
  — so reading a photo is one lookup (``app.files.access``), the family
  timeline is a join, and search includes it like a shared album.

Archived photos and videos stay out; trashed ones drop out of the library
and so out of the family. Leaving, or being removed, takes your photos out
at once.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import date
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.family")

MODES = ("none", "all", "since", "people")
REFRESH_EVERY = "5 minutes"


class FamilyError(ValueError):
    pass


async def membership(db: AsyncSession, user_id: uuid.UUID) -> Any | None:
    """(family_id, name, owner_id, share_mode, share_since, share_people)."""
    return (await db.execute(
        text(
            "SELECT f.id AS family_id, f.name, f.owner_id, m.share_mode, m.share_since, m.share_people "
            "FROM photo_family_members m JOIN photo_families f ON f.id = m.family_id WHERE m.user_id = :u"
        ),
        {"u": user_id},
    )).mappings().first()


async def _wanted(db: AsyncSession, user_id: uuid.UUID, mode: str, since: date | None, people: list[uuid.UUID] | None) -> list[uuid.UUID]:
    """The member's photos their share puts in."""
    from sqlalchemy import select

    from app.files.models import UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    if mode == "none":
        return []
    q = (
        select(PhotoAsset.file_id)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .where(in_library(user_id), PhotoAsset.archived_at.is_(None))
    )
    if mode == "since" and since:
        from datetime import datetime

        q = q.where(PhotoAsset.taken_local >= datetime.combine(since, datetime.min.time()))
    if mode == "people":
        ids = [str(p) for p in people or []]
        if not ids:
            return []
        q = q.where(
            text(
                "(EXISTS (SELECT 1 FROM photo_faces o WHERE o.file_id = photo_assets.file_id AND o.person_id = ANY(CAST(:ppl AS uuid[]))) "
                "OR EXISTS (SELECT 1 FROM photo_animals o WHERE o.file_id = photo_assets.file_id AND o.pet_id = ANY(CAST(:ppl AS uuid[]))))"
            ).bindparams(ppl=ids)
        )
    return list((await db.execute(q)).scalars())


async def refresh(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    """Bring one member's photos in the family in line with their share:
    (added, taken out). Flushed, not committed."""
    m = await membership(db, user_id)
    if m is None:
        await db.execute(text("DELETE FROM photo_family_items WHERE owner_id = :u"), {"u": user_id})
        return 0, 0
    want = [str(i) for i in await _wanted(db, user_id, m["share_mode"], m["share_since"], m["share_people"])]
    added = await db.execute(
        text(
            "INSERT INTO photo_family_items (family_id, file_id, owner_id) "
            "SELECT :fam, f, :u FROM unnest(CAST(:ids AS uuid[])) AS f ON CONFLICT DO NOTHING"
        ),
        {"fam": m["family_id"], "u": user_id, "ids": want},
    )
    gone = await db.execute(
        text(
            "DELETE FROM photo_family_items WHERE owner_id = :u AND (family_id <> :fam OR NOT (file_id = ANY(CAST(:ids AS uuid[]))))"
        ),
        {"fam": m["family_id"], "u": user_id, "ids": want},
    )
    await db.execute(text("UPDATE photo_family_members SET checked_at = now() WHERE user_id = :u"), {"u": user_id})
    return added.rowcount or 0, gone.rowcount or 0


async def refresh_due(budget: float = 10.0) -> int:
    """Members whose share hasn't been looked at for a few minutes."""
    from app.database import SessionLocal

    started = time.monotonic()
    async with SessionLocal() as db:
        due = list((await db.execute(
            text(
                f"SELECT user_id FROM photo_family_members WHERE share_mode <> 'none' AND (checked_at IS NULL "
                f"OR checked_at < now() - interval '{REFRESH_EVERY}') ORDER BY checked_at NULLS FIRST LIMIT 50"
            )
        )).scalars())
    n = 0
    for uid in due:
        if time.monotonic() - started >= budget:
            break
        try:
            async with SessionLocal() as db:
                await refresh(db, uid)
                await db.commit()
            n += 1
        except Exception:  # noqa: BLE001 — one member never stops the rest
            logger.exception("family share of %s", uid)
    return n


async def create(db: AsyncSession, owner: Any, name: str) -> uuid.UUID:
    if await membership(db, owner.id):
        raise FamilyError("You're already in a family — leave it first.")
    fid = await db.scalar(
        text("INSERT INTO photo_families (name, owner_id) VALUES (:n, :u) RETURNING id"),
        {"n": (name or "").strip()[:120] or "Family", "u": owner.id},
    )
    await db.execute(text("INSERT INTO photo_family_members (family_id, user_id) VALUES (:f, :u)"), {"f": fid, "u": owner.id})
    return fid


async def add_member(db: AsyncSession, owner: Any, user_id: uuid.UUID) -> None:
    m = await membership(db, owner.id)
    if m is None or m["owner_id"] != owner.id:
        raise FamilyError("Only the family's owner can add people.")
    other = await db.scalar(text("SELECT id FROM users WHERE id = :u AND NOT disabled"), {"u": user_id})
    if other is None or other == owner.id:
        raise FamilyError("No such person.")
    if await membership(db, other):
        raise FamilyError("They're already in a family.")
    await db.execute(text("INSERT INTO photo_family_members (family_id, user_id) VALUES (:f, :u)"), {"f": m["family_id"], "u": other})


async def remove_member(db: AsyncSession, actor: Any, user_id: uuid.UUID) -> None:
    """The owner removes someone, or someone leaves. The owner leaving
    ends the family for everyone."""
    m = await membership(db, actor.id)
    if m is None:
        raise FamilyError("You're not in a family.")
    if user_id != actor.id and m["owner_id"] != actor.id:
        raise FamilyError("Only the family's owner can remove people.")
    if user_id == m["owner_id"]:
        await db.execute(text("DELETE FROM photo_families WHERE id = :f"), {"f": m["family_id"]})
        return
    await db.execute(
        text("DELETE FROM photo_family_members WHERE family_id = :f AND user_id = :u"), {"f": m["family_id"], "u": user_id}
    )
    await db.execute(
        text("DELETE FROM photo_family_items WHERE family_id = :f AND owner_id = :u"), {"f": m["family_id"], "u": user_id}
    )


async def set_share(db: AsyncSession, user: Any, mode: str, since: date | None, people: list[uuid.UUID] | None) -> None:
    if mode not in MODES:
        raise FamilyError("Unknown share.")
    if await membership(db, user.id) is None:
        raise FamilyError("You're not in a family.")
    if mode == "since" and since is None:
        raise FamilyError("From which date?")
    if mode == "people":
        if not people:
            raise FamilyError("Which people?")
        own = set((await db.execute(
            text("SELECT id FROM photo_people WHERE user_id = :u AND id = ANY(CAST(:p AS uuid[]))"),
            {"u": user.id, "p": [str(p) for p in people]},
        )).scalars())
        people = [p for p in people if p in own]
        if not people:
            raise FamilyError("Those aren't people in your photos.")
    await db.execute(
        text(
            "UPDATE photo_family_members SET share_mode = :m, share_since = :s, share_people = CAST(:p AS uuid[]), checked_at = NULL "
            "WHERE user_id = :u"
        ),
        {"m": mode, "s": since if mode == "since" else None, "p": [str(p) for p in people] if mode == "people" else None, "u": user.id},
    )
    await refresh(db, user.id)


FAMILY_SQL = (
    "SELECT fi.file_id FROM photo_family_items fi "
    "JOIN photo_family_members fm ON fm.family_id = fi.family_id AND fm.user_id = :u"
)


__all__ = ["FAMILY_SQL", "FamilyError", "MODES", "add_member", "create", "membership", "refresh", "refresh_due", "remove_member", "set_share"]

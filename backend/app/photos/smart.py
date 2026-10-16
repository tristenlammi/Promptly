"""Smart albums (PH-5, Part E §E2.5): "Always add Sarah", "Max at the
beach", "Kids, 2026" — an album that is a saved question, kept correct as
photos arrive (and as people are named, and as photos are understood).

The question is stored in ``albums.rules`` in the chat tool's shape (people
and pets by id where they were chosen, so a rename doesn't break it;
"my kids" stays a relationship, so a new child joins). Its matches are
ordinary ``album_items`` marked ``via_rule``: sharing, public links and
access treat them as any album's. Each refresh adds what newly matches and
takes out what no longer does — never a photo someone put in by hand, and
never back a photo the owner took out (``album_exclusions``).

Refreshed in the understanding tick (every album at most every five
minutes), and at once when made or changed.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.smart")

REFRESH_EVERY = "5 minutes"


async def refresh(db: AsyncSession, album_id: uuid.UUID) -> tuple[int, int] | None:
    """(added, taken out); None when it can't be told now. Flushed."""
    from app.auth.models import User
    from app.photos import engine

    row = (await db.execute(text("SELECT owner_id, rules FROM albums WHERE id = :a"), {"a": album_id})).first()
    if row is None or not row.rules:
        return None
    owner = await db.get(User, row.owner_id)
    ids = await engine.matching(db, owner, engine.query_from(row.rules))
    await db.execute(text("UPDATE albums SET rules_checked_at = now() WHERE id = :a"), {"a": album_id})
    if ids is None:
        return None
    wanted = [str(i) for i in ids]
    added = await db.execute(
        text(
            "INSERT INTO album_items (album_id, file_id, added_by, via_rule) "
            "SELECT :a, f, :o, true FROM unnest(CAST(:ids AS uuid[])) AS f "
            "WHERE NOT EXISTS (SELECT 1 FROM album_exclusions x WHERE x.album_id = :a AND x.file_id = f) "
            "ON CONFLICT (album_id, file_id) DO NOTHING"
        ),
        {"a": album_id, "o": row.owner_id, "ids": wanted},
    )
    gone = await db.execute(
        text("DELETE FROM album_items WHERE album_id = :a AND via_rule AND NOT (file_id = ANY(CAST(:ids AS uuid[])))"),
        {"a": album_id, "ids": wanted},
    )
    if (added.rowcount or 0) or (gone.rowcount or 0):
        await db.execute(text("UPDATE albums SET updated_at = now() WHERE id = :a"), {"a": album_id})
    return added.rowcount or 0, gone.rowcount or 0


async def refresh_due(budget: float = 10.0) -> int:
    """The smart albums not looked at for five minutes — oldest first."""
    from app.database import SessionLocal

    started = time.monotonic()
    n = 0
    async with SessionLocal() as db:
        due = list((await db.execute(
            text(
                f"SELECT id FROM albums WHERE rules IS NOT NULL AND (rules_checked_at IS NULL "
                f"OR rules_checked_at < now() - interval '{REFRESH_EVERY}') ORDER BY rules_checked_at NULLS FIRST LIMIT 50"
            )
        )).scalars())
    for album_id in due:
        if time.monotonic() - started >= budget:
            break
        try:
            async with SessionLocal() as db:
                await refresh(db, album_id)
                await db.commit()
            n += 1
        except Exception:  # noqa: BLE001 — one album never stops the rest
            logger.exception("smart album %s", album_id)
    return n


async def rule_names(db: AsyncSession, rules: dict[str, Any]) -> dict[str, str]:
    """``id:…`` references → current names, for the album's description."""
    ids = [r[3:] for r in [*(rules.get("people") or []), *(rules.get("pets") or [])] if str(r).startswith("id:")]
    if not ids:
        return {}
    rows = (await db.execute(
        text("SELECT id::text, COALESCE(name, 'someone') FROM photo_people WHERE id::text = ANY(CAST(:ids AS text[]))"),
        {"ids": ids},
    )).all()
    return {f"id:{i}": n for i, n in rows}


__all__ = ["refresh", "refresh_due", "rule_names"]

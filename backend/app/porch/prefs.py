"""Porch → Settings → Notifications, and "Notify me when they post"
(build §3.11, WP-P1.7).

* Each kind (new posts, comments, replies, mentions, tags, invites,
  reactions, birthdays) is **On**, **Daily summary** or **Off**, kept with
  Porch in ``porch_profiles.push``. Reactions start on Daily summary.
* Porch's switch in Account → Notifications (``push_preferences.porch``) is
  shown here too, so it can be turned back on from Porch.
* "Notify me when they post" (``porch_alerts``): per person, only people
  Porch is on for and with no block either way.
* The per-group bell is ``PATCH /groups/{id}/me {notify}`` (groups.py).
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.people import blocks

from . import core, deps, posts, push
from .deps import require_porch
from .models import PorchAlert

router = APIRouter()

Mode = Literal["on", "summary", "off"]


async def _account(db: AsyncSession, user: User) -> dict:
    from app.notifications.models import PushPreferences
    from app.notifications import quiet

    p = await db.get(PushPreferences, user.id)
    out = {
        "push_enabled": p.enabled if p is not None else True,
        "porch": p.porch if p is not None else True,
        "quiet_enabled": bool(p.quiet_enabled) if p is not None else False,
        "quiet_start": p.quiet_start.strftime("%H:%M") if p is not None and p.quiet_start else "22:00",
        "quiet_end": p.quiet_end.strftime("%H:%M") if p is not None and p.quiet_end else "07:00",
        "timezone": str(quiet.zone_of(user.settings).key),
    }
    try:
        from app.today.push import prefs as today_prefs

        out["summary_time"] = (await today_prefs(db, user))["time"]
    except Exception:  # noqa: BLE001 — the page works without it
        out["summary_time"] = "08:00"
    return out


async def _out(db: AsyncSession, user: User) -> dict:
    prof = await core.profile(db, user.id)
    return {"modes": push.modes_of(prof.push), "defaults": push.DEFAULTS, "kinds": list(push.KINDS), "account": await _account(db, user)}


@router.get("/me/notifications")
async def get_notifications(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    out = await _out(db, user)
    await db.commit()
    return out


class NotificationsPatch(BaseModel):
    modes: dict[str, Mode] | None = None
    # Porch's switch in Account → Notifications.
    porch: bool | None = None


@router.patch("/me/notifications")
async def patch_notifications(body: NotificationsPatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    if body.modes:
        bad = [k for k in body.modes if k not in push.KINDS]
        if bad:
            raise core.bad(f"Unknown kind: {', '.join(bad)}")
        prof = await core.profile(db, user.id)
        prof.push = {**push.modes_of(prof.push), **body.modes}
    if body.porch is not None:
        from app.notifications.models import PushPreferences

        p = await db.get(PushPreferences, user.id)
        if p is None:
            p = PushPreferences(user_id=user.id)
            db.add(p)
        p.porch = body.porch
    await db.commit()
    return await _out(db, user)


# ------------------------------------------------------------------ "Notify me when they post"


@router.get("/alerts")
async def list_alerts(db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> list[dict]:
    """The people you're told about when they post (still on Porch, no block)."""
    s = await deps.settings(db)
    hidden = await blocks.hidden_ids(db, user.id)
    rows = (
        await db.execute(
            select(User)
            .join(PorchAlert, PorchAlert.author_id == User.id)
            .where(PorchAlert.user_id == user.id, deps.allowed_clause(s, User.id))
            .order_by(User.username)
        )
    ).scalars().all()
    return [core.user_out(u) for u in rows if u.id not in hidden]


@router.put("/alerts/{user_id}")
async def add_alert(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    """Turn on "Notify me when they post" (404 for anyone you can't see)."""
    if user_id == user.id:
        raise core.bad("That's you")
    other = await posts._person(db, user, user_id)
    await db.execute(insert(PorchAlert).values(user_id=user.id, author_id=other.id, created_at=core.now()).on_conflict_do_nothing())
    await db.commit()
    return {"user_id": str(other.id), "alert": True}


@router.delete("/alerts/{user_id}")
async def remove_alert(user_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_porch)) -> dict:
    await db.execute(delete(PorchAlert).where(PorchAlert.user_id == user.id, PorchAlert.author_id == user_id))
    await db.commit()
    return {"user_id": str(user_id), "alert": False}


async def has_alert(db: AsyncSession, user: User, other_id: uuid.UUID) -> bool:
    return await db.get(PorchAlert, (user.id, other_id)) is not None


__all__ = ["has_alert", "router"]

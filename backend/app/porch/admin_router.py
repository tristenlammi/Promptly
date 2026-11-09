"""Admin → Porch (WP-P1.7), mounted at ``/api/admin/porch``: server admins only.

* Porch on or off for the whole server, and who may use it (everyone, or
  the people in chosen **user groups** — the admin panel's groups, not
  Porch's own).
* Video limits for posts (length and size).
* Everyone's name ("Lammi Clan").
* Everyone's reports: things reported in the Everyone group (and only
  those: a report in any other group goes to that group's admins), shown
  only while the admin can see them as an Everyone member. Remove takes a
  post out of Everyone (the poster is told why) or removes a comment; Keep
  leaves it. Nobody is told who reported it.
* Take a post out of Everyone, with a reason.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db

from . import access, core, deps, reports
from .models import PorchPostGroup

router = APIRouter()


async def _settings_row(db: AsyncSession):  # noqa: ANN202
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
        await db.flush()
    return row


async def _out(db: AsyncSession) -> dict:
    from app.groups.models import UserGroup, UserGroupMember

    s = await _settings_row(db)
    ev = await core.everyone(db)
    counts = dict((await db.execute(select(UserGroupMember.group_id, func.count()).group_by(UserGroupMember.group_id))).all())
    ugs = (await db.execute(select(UserGroup).order_by(func.lower(UserGroup.name)))).scalars().all()
    return {
        "enabled": bool(s.porch_enabled),
        "user_group_ids": [str(x) for x in s.porch_user_group_ids] if s.porch_user_group_ids is not None else None,
        "video_max_seconds": int(s.porch_video_max_seconds),
        "video_max_mb": int(s.porch_video_max_mb),
        "everyone_name": ev.name,
        "everyone_emoji": ev.emoji,
        "people": await access.member_count(db, ev) if s.porch_enabled else 0,
        "user_groups": [{"id": str(g.id), "name": g.name, "member_count": int(counts.get(g.id, 0))} for g in ugs],
    }


async def _with_reports(db: AsyncSession, admin: User) -> dict:
    out = await _out(db)
    out["open_reports"] = await reports.open_count(db, admin)
    return out


@router.get("")
async def get_porch(db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict:
    out = await _with_reports(db, admin)
    await db.commit()
    return out


class PorchPatch(BaseModel):
    enabled: bool | None = None
    # null = everyone on this Promptly; a list = only people in these user groups.
    user_group_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)
    video_max_seconds: int | None = Field(default=None, ge=5, le=3600)
    video_max_mb: int | None = Field(default=None, ge=1, le=20480)
    everyone_name: str | None = Field(default=None, max_length=80)
    everyone_emoji: str | None = Field(default=None, max_length=16)


@router.patch("")
async def patch_porch(body: PorchPatch, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict:
    s = await _settings_row(db)
    sent = body.model_fields_set
    if body.enabled is not None:
        s.porch_enabled = body.enabled
    if "user_group_ids" in sent:
        if body.user_group_ids is None:
            s.porch_user_group_ids = None
        else:
            from app.groups.models import UserGroup

            want = list(dict.fromkeys(body.user_group_ids))
            have = set((await db.execute(select(UserGroup.id).where(UserGroup.id.in_(want)))).scalars()) if want else set()
            if set(want) - have:
                raise core.bad("One of those user groups doesn't exist any more")
            if not want:
                raise core.bad("Pick at least one user group, or let everyone use Porch")
            s.porch_user_group_ids = [str(x) for x in want]
    if body.video_max_seconds is not None:
        s.porch_video_max_seconds = body.video_max_seconds
    if body.video_max_mb is not None:
        s.porch_video_max_mb = body.video_max_mb
    if body.everyone_name is not None or body.everyone_emoji is not None:
        ev = await core.everyone(db)
        if body.everyone_name is not None:
            name = body.everyone_name.strip()
            if not name:
                raise core.bad("Give Everyone a name")
            ev.name = name
        if body.everyone_emoji is not None:
            ev.emoji = body.everyone_emoji.strip() or core.EVERYONE_EMOJI
    await db.commit()
    return await _with_reports(db, admin)


# ------------------------------------------------------------------ reports (Everyone's only)


@router.get("/reports")
async def list_reports(status: Literal["open", "handled"] = "open", db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> list[dict]:
    """Reports made in Everyone (never another group's), each shown only if
    this admin can see it as an Everyone member."""
    ev = await core.everyone(db)
    if status == "open":
        out = await reports.queue(db, admin, ev)
    else:
        out = await reports.handled(db, admin, ev)
    await db.commit()
    return out


@router.post("/reports/{report_id}")
async def decide(report_id: uuid.UUID, body: reports.DecideIn, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict:
    """Take a post out of Everyone or remove a comment (the poster sees the
    reason), or keep it. Every open report on it in Everyone closes with it."""
    ev = await core.everyone(db)
    return await reports.decide(db, admin, ev, report_id, body.action, body.reason)


class RemoveIn(BaseModel):
    reason: str = Field(default="", max_length=500)


@router.post("/posts/{post_id}/remove-from-everyone")
async def remove_from_everyone(post_id: uuid.UUID, body: RemoveIn, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict:
    """Take a post out of Everyone (the server admins run Everyone). It stays
    in the poster's other groups; the poster is told why."""
    if not await deps.allowed(db, admin):
        raise core.not_found()
    post = await access.load_post(db, admin, post_id)
    ev = await core.everyone(db)
    inside = (await db.execute(select(PorchPostGroup).where(PorchPostGroup.post_id == post.id, PorchPostGroup.group_id == ev.id))).first()
    if inside is None:
        raise core.bad("This post isn't in Everyone")
    return await reports.remove_post(db, admin, post, body.reason.strip(), group=ev)


__all__ = ["router"]

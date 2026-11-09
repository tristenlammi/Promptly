"""``GET /api/badges``: the sidebar's count badges (see :mod:`app.badges`)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import apps, collect

router = APIRouter()


@router.get("")
async def get_badges(
    apps_: str | None = Query(default=None, alias="apps", max_length=500, description="Comma-separated row ids; all when left out"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    """``{app: count}`` for the rows you can use, e.g.
    ``{"tasks": 2, "mail": 5, "rooms": 3, "porch": 1}``. Zero means no badge;
    a row that isn't for you (Porch off for you) is left out."""
    only = None
    if apps_ is not None:
        known = set(apps())
        only = [a for a in (x.strip() for x in apps_.split(",")) if a in known]
    out = await collect(db, user, only)
    # Nothing here is written; drop the read transaction (and any savepoints).
    await db.rollback()
    return out

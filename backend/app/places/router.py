"""Places (``/api/places``): one list and map across apps.

    GET /api/places   every place, grouped, with what's there from each app,
                      plus a link to the same map as Photos
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()


@router.get("")
async def places(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.maps.links import basemap_link

    from . import core

    out = await core.build(db, user)
    out["basemap"] = await basemap_link(user)
    return out

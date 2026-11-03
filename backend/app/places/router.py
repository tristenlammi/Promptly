"""Places (``/api/places``): one list and map across apps.

    GET /api/places   every place, grouped, with what's there from each app,
                      plus the same basemap settings as the Photos map
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()


@router.get("")
async def places(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.config import get_settings as get_app_config
    from app.photos.router import _basemap_path

    from . import core

    out = await core.build(db, user)
    basemap = await asyncio.to_thread(_basemap_path)
    out["basemap"] = "/api/photos/basemap.pmtiles" if basemap else None
    out["online"] = bool(get_app_config().PHOTOS_ONLINE_MAP)
    return out

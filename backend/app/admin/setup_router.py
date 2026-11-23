"""/api/admin/setup: the "Finish setting up" checklist and the model
suggestions the first-run wizard fills in. Admin only."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import setup
from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db
from app.redis_client import redis

router = APIRouter()


@router.get("")
async def get_checklist(
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """What's set up and what isn't, each row checked against the server."""
    dismissed = bool((admin.settings or {}).get("setup_card_dismissed"))
    result = await setup.checklist(db, admin, redis, request_host=request.headers.get("host"))
    return result.out(dismissed=dismissed)


@router.get("/model-suggestions")
async def model_suggestions(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """A pick for each model job from what the connected providers offer."""
    from app.models_config.router import list_available_models_for

    models = await list_available_models_for(admin, db)
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return setup.suggest_models(models, row)

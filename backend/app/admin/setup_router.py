"""/api/admin/setup: the "Finish setting up" checklist and the model
suggestions the first-run wizard fills in. Admin only."""
from __future__ import annotations

from typing import Any

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
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

    from app.custom_models import builtin

    models = await list_available_models_for(admin, db)
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return setup.suggest_models(models, row, await builtin.get(db))


class PromptlyModel(BaseModel):
    provider_id: uuid.UUID
    model_id: str = Field(min_length=1, max_length=128)
    # New chats start on Promptly. The wizard says yes; Admin can say no.
    make_default: bool = True


@router.put("/promptly-model")
async def set_promptly_model(
    payload: PromptlyModel,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """Put a model behind the built-in Promptly model and (by default) make
    Promptly what new chats start on."""
    from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict
    from app.custom_models import builtin
    from app.custom_models.resolver import is_custom_model_id
    from app.models_config.models import ModelProvider
    from app.models_config.router import list_available_models_for

    cm = await builtin.get(db)
    if cm is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This server no longer has the built-in Promptly model.")
    provider = await db.get(ModelProvider, payload.provider_id)
    if provider is None or not provider.enabled or is_custom_model_id(payload.model_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Pick a model from a connected AI service.")
    if payload.model_id not in {m.get("id") for m in (provider.models or [])}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{provider.name} doesn't have that model.")
    await builtin.set_base(db, cm, provider, payload.model_id, make_default=payload.make_default)
    await record_event(
        db,
        request=request,
        event_type=EVENT_APP_SETTINGS_CHANGED,
        user_id=admin.id,
        identifier=admin.username,
        detail=safe_dict({"promptly_model": payload.model_id, "default": payload.make_default}),
    )
    await db.commit()
    models = await list_available_models_for(admin, db)
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return {
        "id": str(cm.id),
        "model_id": f"custom:{cm.id}",
        "provider_id": str(provider.id),
        "default_chat_provider_id": str(row.default_chat_provider_id) if row and row.default_chat_provider_id else None,
        "default_chat_model_id": row.default_chat_model_id if row else None,
        "listed": any(m.model_id == f"custom:{cm.id}" and not m.needs_setup for m in models),
    }


@router.get("/embedding-options")
async def embedding_options(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, Any]:
    """Reading (embedding) models the connected AI services can provide
    with the key they already have."""
    from sqlalchemy import select

    from app.models_config.models import ModelProvider

    providers = (await db.execute(select(ModelProvider).where(ModelProvider.enabled.is_(True)).order_by(ModelProvider.name))).scalars().all()
    return {"options": setup.embedding_options(list(providers))}

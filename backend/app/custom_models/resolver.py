"""Chat-side helpers for resolving synthetic ``custom:<uuid>`` model ids.

Kept as a tiny standalone module so :mod:`app.chat.router` can import
it without pulling the full Custom Models router (including its
FastAPI :class:`BackgroundTasks` machinery) into the chat module's
import graph.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.custom_models.models import CustomModel
from app.models_config.models import ModelProvider


# Prefix used by :func:`app.models_config.router.list_available_models_for`
# when it emits a synthetic ``AvailableModel`` row for a custom model.
# Centralised so the chat router and the picker logic can't drift apart.
CUSTOM_MODEL_PREFIX = "custom:"


@dataclass(frozen=True)
class ResolvedCustomModel:
    """The three things the chat dispatcher needs after resolution."""

    custom_model: CustomModel
    base_provider: ModelProvider
    base_model_id: str


def is_custom_model_id(model_id: str | None) -> bool:
    """Cheap prefix check — used before any DB call."""
    return bool(model_id) and model_id.startswith(CUSTOM_MODEL_PREFIX)


def parse_custom_model_id(model_id: str) -> uuid.UUID | None:
    """Extract the CustomModel UUID from ``custom:<uuid>``. ``None`` on bad input."""
    if not is_custom_model_id(model_id):
        return None
    raw = model_id[len(CUSTOM_MODEL_PREFIX) :]
    try:
        return uuid.UUID(raw)
    except (ValueError, AttributeError):
        return None


async def resolve_custom_model(
    model_id: str, db: AsyncSession
) -> ResolvedCustomModel | None:
    """Look up the ``CustomModel`` + its base provider for a synthetic id.

    Returns ``None`` (caller falls back to non-custom dispatch) for:

    * ids that don't carry the ``custom:`` prefix,
    * ids whose UUID doesn't resolve to a ``CustomModel`` row,
    * custom models pointing at a base provider that has since been
      deleted or disabled (the chat dispatcher then surfaces a
      clean "provider no longer exists" error).
    """
    cm_id = parse_custom_model_id(model_id)
    if cm_id is None:
        return None
    cm = await db.get(CustomModel, cm_id)
    if cm is None:
        return None
    if cm.base_provider_id is None or not cm.base_model_id:
        # No model behind it yet: see :func:`unavailable_reason`.
        return None
    provider = await db.get(ModelProvider, cm.base_provider_id)
    if provider is None or not provider.enabled:
        return None
    return ResolvedCustomModel(
        custom_model=cm, base_provider=provider, base_model_id=cm.base_model_id
    )


async def unavailable_reason(model_id: str, db: AsyncSession, *, admin: bool) -> str:
    """Why :func:`resolve_custom_model` returned ``None``, in words fit to
    show the person who sent the message."""
    cm_id = parse_custom_model_id(model_id)
    cm = await db.get(CustomModel, cm_id) if cm_id else None
    if cm is not None and (cm.base_provider_id is None or not cm.base_model_id):
        from app.custom_models.builtin import not_ready_message

        return not_ready_message(cm, admin=admin)
    return (
        "This custom model is no longer available. "
        "Ask an admin to re-create it, or pick a different model."
    )


async def base_pair(
    db: AsyncSession, provider_id: uuid.UUID | None, model_id: str | None
) -> tuple[ModelProvider, str] | None:
    """The enabled provider and real model id behind a stored
    ``(provider_id, model_id)`` pair, custom or not. ``None`` when it can't
    be used (unset, provider gone or disabled, custom model not ready).

    For callers that hold a default pair and call the provider directly:
    a ``custom:<uuid>`` id means nothing to a provider.
    """
    if not model_id:
        return None
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        return (resolved.base_provider, resolved.base_model_id) if resolved is not None else None
    if provider_id is None:
        return None
    provider = await db.get(ModelProvider, provider_id)
    if provider is None or not provider.enabled:
        return None
    return provider, model_id

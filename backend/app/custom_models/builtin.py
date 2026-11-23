"""The built-in "Promptly" custom model.

Every install has one custom model called Promptly, so a new person's
first chat says "Promptly" in the picker rather than a provider's model
name. It is an ordinary custom model (Admin → Models → Custom models:
rename it, give it knowledge, delete it) with two differences:

* it is made by the server, once (:func:`provision`, at start-up), and
  never again: ``app_settings.builtin_model_seeded`` records that;
* it may have no model behind it yet. On a fresh install no AI service is
  connected, so it starts "not ready" and the setup wizard's Models step
  (or Admin) gives it one with :func:`set_base`.

Its prompt is short on purpose: the app's base prompt already covers the
date, the tools and how to answer.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.custom_models.models import CustomModel
from app.custom_models.resolver import CUSTOM_MODEL_PREFIX, is_custom_model_id
from app.models_config.models import ModelProvider

logger = logging.getLogger(__name__)

NAME = "promptly"
DISPLAY_NAME = "Promptly"
DESCRIPTION = "Your family's assistant. An admin chooses the model behind it."
PERSONALITY = (
    "You are Promptly, the assistant built into this family's own private server. "
    "Be warm, clear and brief, and use plain words. "
    "When you aren't sure of something, say so."
)

# Where an admin gives the built-in model its model.
SETUP_LINK = "/setup?step=models"


async def _settings(db: AsyncSession) -> AppSettings:
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
        await db.flush()
    return row


async def builtin_id(db: AsyncSession) -> uuid.UUID | None:
    """The built-in model's id, when it still exists."""
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return getattr(row, "builtin_model_id", None) if row is not None else None


async def get(db: AsyncSession) -> CustomModel | None:
    """The built-in model, or None when an admin deleted it."""
    cm_id = await builtin_id(db)
    return await db.get(CustomModel, cm_id) if cm_id else None


def ready(cm: CustomModel) -> bool:
    return bool(cm.base_provider_id and cm.base_model_id)


async def provision(db: AsyncSession) -> CustomModel | None:
    """Make the Promptly model, once per install. Safe to call at every
    start: after the first time it does nothing, whatever an admin has
    done to the model since.

    On an install that already has a default chat model, Promptly is
    pointed at that model so it works at once. The default itself is left
    exactly as it was: only the wizard (or an admin) makes Promptly the
    default.
    """
    settings = await _settings(db)
    if settings.builtin_model_seeded:
        return None
    # An admin's own custom model already called "promptly" becomes it.
    cm = (await db.execute(select(CustomModel).where(CustomModel.name == NAME))).scalar_one_or_none()
    if cm is None:
        provider_id, model_id = None, None
        if (
            settings.default_chat_provider_id
            and settings.default_chat_model_id
            and not is_custom_model_id(settings.default_chat_model_id)
        ):
            provider = await db.get(ModelProvider, settings.default_chat_provider_id)
            ids = {m.get("id") for m in (provider.models or [])} if provider is not None else set()
            if provider is not None and settings.default_chat_model_id in ids:
                provider_id, model_id = provider.id, settings.default_chat_model_id
        cm = CustomModel(
            name=NAME,
            display_name=DISPLAY_NAME,
            description=DESCRIPTION,
            personality=PERSONALITY,
            base_provider_id=provider_id,
            base_model_id=model_id,
        )
        db.add(cm)
        await db.flush()
        logger.info("Made the built-in Promptly model (%s).", "ready" if model_id else "no model behind it yet")
    settings.builtin_model_id = cm.id
    settings.builtin_model_seeded = True
    granted = await _grant_to_existing_lists(db, cm)
    await db.commit()
    if granted:
        logger.info("Added the built-in Promptly model to %d people's model lists.", granted)
    return cm


async def _grant_to_existing_lists(db: AsyncSession, cm: CustomModel) -> int:
    """People whose account is limited to a list of models (locked ones
    included: their own model stays first) get Promptly added to that list,
    this once, as the model is first made. Not people with full access
    (no list), nor people an admin gave no models at all (an empty list is
    "no AI for this person", and stays that). It is then an ordinary
    entry: an admin who unticks it has it stay unticked, because this never
    runs again (``builtin_model_seeded``). Returns how many lists grew."""
    from app.auth.models import User

    synthetic = f"{CUSTOM_MODEL_PREFIX}{cm.id}"
    people = (await db.execute(select(User).where(User.role != "admin"))).scalars().all()
    changed = 0
    for person in people:
        # None (in the database: NULL or a JSON null) is full access.
        if not person.allowed_models:
            continue
        have = list(person.allowed_models)
        if synthetic in have:
            continue
        # A new list object, so the change is seen and saved.
        person.allowed_models = [*have, synthetic]
        changed += 1
    return changed


async def set_base(
    db: AsyncSession, cm: CustomModel, provider: ModelProvider, model_id: str, *, make_default: bool
) -> None:
    """Put a model behind ``cm``; with ``make_default``, new chats start
    on it. The caller commits."""
    cm.base_provider_id = provider.id
    cm.base_model_id = model_id
    settings = await _settings(db)
    synthetic = f"{CUSTOM_MODEL_PREFIX}{cm.id}"
    if make_default or settings.default_chat_model_id == synthetic:
        # A custom default is stored as (its base provider, custom:<id>),
        # the pair the picker lists it under.
        settings.default_chat_provider_id = provider.id
        settings.default_chat_model_id = synthetic


async def follow_base(db: AsyncSession, cm: CustomModel) -> None:
    """After a custom model's base changed: keep the default chat pair
    pointing at the provider it now lives under."""
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is not None and settings.default_chat_model_id == f"{CUSTOM_MODEL_PREFIX}{cm.id}":
        settings.default_chat_provider_id = cm.base_provider_id


async def release_provider(db: AsyncSession, provider_id: uuid.UUID) -> None:
    """Before a provider is deleted: the built-in model goes back to "not
    ready" instead of being deleted with it (the foreign key cascades)."""
    cm = await get(db)
    if cm is not None and cm.base_provider_id == provider_id:
        cm.base_provider_id = None
        cm.base_model_id = None
        await db.flush()


def not_ready_message(cm: CustomModel, *, admin: bool) -> str:
    """What someone reads when they message a custom model that has no
    model behind it yet. Plain words, never a raw error."""
    name = cm.display_name or DISPLAY_NAME
    if admin:
        return (
            f"{name} doesn't have a model behind it yet. Choose one in Admin → Setup "
            "(or Admin → Models → Custom models) and it will answer."
        )
    return f"{name} doesn't have a model behind it yet. Ask the person who runs this server to choose one."

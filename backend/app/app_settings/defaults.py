"""Effective model-role defaults, resolved per caller.

Every runtime site that asks "which model fills role X (chat / vision-relay /
research / study / assessor)?" resolves it through :func:`load_effective_defaults`
so the org→global precedence lives in exactly one place and the call sites stay a
one-line swap from the old ``db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)``.

Precedence
----------
* ``org_id`` set   → the org's own :class:`OrgModelDefaults` row. An unset pair
  stays unset (``None``) — it does NOT fall back to the global default, because
  the global default points at *another* tenant's provider and would be
  inaccessible / a cross-tenant leak. Unset simply means "off / catalog
  fallback" for that role, exactly as a fresh install behaves.
* ``org_id`` None  → self-host / custom-auth (no tenancy): use the
  ``AppSettings`` singleton's global defaults, preserving historical behaviour.

The returned object exposes the SAME attribute + ``*_configured`` names as
``AppSettings`` so callers read it identically.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import (
    SINGLETON_APP_SETTINGS_ID,
    AppSettings,
    OrgModelDefaults,
)
from app.auth.models import User


@dataclass(frozen=True)
class EffectiveDefaults:
    """The resolved model-role defaults for one caller.

    Field + property names mirror ``AppSettings`` / ``OrgModelDefaults`` so a
    call site can swap the source without touching how it reads the values.
    """

    default_chat_provider_id: uuid.UUID | None = None
    default_chat_model_id: str | None = None
    vision_relay_provider_id: uuid.UUID | None = None
    vision_relay_model_id: str | None = None
    research_provider_id: uuid.UUID | None = None
    research_model_id: str | None = None
    study_provider_id: uuid.UUID | None = None
    study_model_id: str | None = None
    study_assessor_provider_id: uuid.UUID | None = None
    study_assessor_model_id: str | None = None

    @property
    def default_chat_configured(self) -> bool:
        return bool(self.default_chat_provider_id and self.default_chat_model_id)

    @property
    def vision_relay_configured(self) -> bool:
        return bool(self.vision_relay_provider_id and self.vision_relay_model_id)

    @property
    def research_configured(self) -> bool:
        return bool(self.research_provider_id and self.research_model_id)

    @property
    def study_configured(self) -> bool:
        return bool(self.study_provider_id and self.study_model_id)

    @property
    def study_assessor_configured(self) -> bool:
        return bool(
            self.study_assessor_provider_id and self.study_assessor_model_id
        )


_PAIR_FIELDS = (
    ("default_chat_provider_id", "default_chat_model_id"),
    ("vision_relay_provider_id", "vision_relay_model_id"),
    ("research_provider_id", "research_model_id"),
    ("study_provider_id", "study_model_id"),
    ("study_assessor_provider_id", "study_assessor_model_id"),
)


def _from_source(src) -> EffectiveDefaults:
    """Copy the 10 default columns off an ``AppSettings`` / ``OrgModelDefaults``."""
    values: dict[str, object] = {}
    for pid, mid in _PAIR_FIELDS:
        values[pid] = getattr(src, pid, None)
        values[mid] = getattr(src, mid, None)
    return EffectiveDefaults(**values)  # type: ignore[arg-type]


async def load_effective_defaults(
    db: AsyncSession, org_id: uuid.UUID | None
) -> EffectiveDefaults:
    """Resolve the model-role defaults for a caller in ``org_id``.

    See the module docstring for precedence. Never raises — a missing org row
    or missing singleton collapses to an all-``None`` (everything "off").
    """
    if org_id is not None:
        row = await db.get(OrgModelDefaults, org_id)
        if row is None:
            return EffectiveDefaults()
        return _from_source(row)

    # No tenancy → self-host / custom auth: the global singleton IS the default.
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        return EffectiveDefaults()
    return _from_source(settings)


async def org_id_of(db: AsyncSession, user_id: uuid.UUID | None) -> uuid.UUID | None:
    """Convenience for background/service sites that only hold an owner id.

    Returns the user's ``org_id`` (or ``None`` if the user is missing / has no
    org), so those sites can resolve defaults for the resource's owner.
    """
    if user_id is None:
        return None
    user = await db.get(User, user_id)
    return user.org_id if user is not None else None


__all__ = ["EffectiveDefaults", "load_effective_defaults", "org_id_of"]

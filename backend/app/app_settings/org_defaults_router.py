"""Per-org model-role defaults API (org admins).

``GET  /api/admin/org-defaults`` → the caller's org defaults (lazily empty).
``PATCH /api/admin/org-defaults`` → partial update, paired semantics.

Gated on :func:`require_org_admin` and hard-scoped to the caller's own org via
:func:`org_scope_for` — an org admin can only read/write **their** tenant's
defaults, and can only point a default at a provider **their org owns** (checked
on write). The platform admin is just another org here (their own org); the
fleet-wide singleton (``/admin/app-settings``) is unaffected.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import OrgModelDefaults
from app.auth.deps import org_scope_for, require_org_admin
from app.auth.models import User
from app.database import get_db
from app.models_config.models import ModelProvider

router = APIRouter()

# The five (provider_id, model_id) default pairs this surface manages.
_PAIRS = (
    ("default_chat_provider_id", "default_chat_model_id"),
    ("vision_relay_provider_id", "vision_relay_model_id"),
    ("research_provider_id", "research_model_id"),
    ("study_provider_id", "study_model_id"),
    ("study_assessor_provider_id", "study_assessor_model_id"),
)


class OrgDefaultsResponse(BaseModel):
    """Current per-org model-role defaults + their configured flags.

    Field names mirror the ``app_settings`` model-default fields so the
    frontend Defaults cards render unchanged.
    """

    model_config = ConfigDict(protected_namespaces=())

    default_chat_provider_id: uuid.UUID | None = None
    default_chat_model_id: str | None = None
    default_chat_configured: bool = False

    vision_relay_provider_id: uuid.UUID | None = None
    vision_relay_model_id: str | None = None
    vision_relay_configured: bool = False

    research_provider_id: uuid.UUID | None = None
    research_model_id: str | None = None
    research_configured: bool = False

    study_provider_id: uuid.UUID | None = None
    study_model_id: str | None = None
    study_configured: bool = False

    study_assessor_provider_id: uuid.UUID | None = None
    study_assessor_model_id: str | None = None
    study_assessor_configured: bool = False


class OrgDefaultsUpdate(BaseModel):
    """PATCH payload. Each pair moves together (both set, or both null to
    clear); omitted pairs are left unchanged (distinguished via
    ``model_fields_set``)."""

    model_config = ConfigDict(protected_namespaces=())

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


def _configured(pid, mid) -> bool:
    return bool(pid and mid)


def _to_response(row: OrgModelDefaults | None) -> OrgDefaultsResponse:
    if row is None:
        return OrgDefaultsResponse()
    data: dict[str, object] = {}
    for pid, mid in _PAIRS:
        p = getattr(row, pid)
        m = getattr(row, mid)
        data[pid] = p
        data[mid] = m
        data[pid.replace("_provider_id", "_configured")] = _configured(p, m)
    # study_assessor's configured key derives correctly from the replace above
    # ("study_assessor_provider_id" → "study_assessor_configured").
    return OrgDefaultsResponse(**data)  # type: ignore[arg-type]


def _org_of(user: User) -> uuid.UUID:
    org_id = org_scope_for(user)
    if org_id is None:
        # An org admin always has an org (require_org_admin enforces it); this
        # guards the degenerate no-org state rather than 500-ing later.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No organization for this account.",
        )
    return org_id


@router.get("", response_model=OrgDefaultsResponse)
async def get_org_defaults(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_org_admin),
) -> OrgDefaultsResponse:
    org_id = _org_of(user)
    row = await db.get(OrgModelDefaults, org_id)
    return _to_response(row)


@router.patch("", response_model=OrgDefaultsResponse)
async def update_org_defaults(
    payload: OrgDefaultsUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_org_admin),
) -> OrgDefaultsResponse:
    org_id = _org_of(user)
    fields = payload.model_fields_set

    row = await db.get(OrgModelDefaults, org_id)
    if row is None:
        row = OrgModelDefaults(org_id=org_id)
        db.add(row)

    # Collect the provider ids being *set* (non-null) so we can validate them
    # all in one query: an org admin may only point a default at a provider
    # their own org owns — never another tenant's, never a system provider.
    pending: dict[str, tuple[uuid.UUID | None, str | None]] = {}
    to_validate: set[uuid.UUID] = set()

    for pid_field, mid_field in _PAIRS:
        pid_set = pid_field in fields
        mid_set = mid_field in fields
        if pid_set != mid_set:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"{pid_field} and {mid_field} must be sent together — "
                    "pass both to set a default, or both as null to clear."
                ),
            )
        if not pid_set:
            continue
        new_pid = getattr(payload, pid_field)
        new_mid = getattr(payload, mid_field)
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{pid_field} and {mid_field} must both be set or both be null.",
            )
        pending[pid_field] = (new_pid, new_mid)
        if new_pid is not None:
            to_validate.add(new_pid)

    if to_validate:
        owned = set(
            (
                await db.execute(
                    select(ModelProvider.id).where(
                        ModelProvider.id.in_(to_validate),
                        ModelProvider.org_id == org_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        missing = to_validate - owned
        if missing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "One or more selected providers don't belong to your "
                    "organization."
                ),
            )

    for pid_field, (new_pid, new_mid) in pending.items():
        mid_field = pid_field.replace("_provider_id", "_model_id")
        setattr(row, pid_field, new_pid)
        setattr(row, mid_field, new_mid)

    await db.commit()
    await db.refresh(row)
    return _to_response(row)


__all__ = ["router"]

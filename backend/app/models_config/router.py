"""Models tab API — CRUD for provider configs + auto-fetch model catalog.

Writes (create / update / delete / test / fetch-models) are admin-only. The
read endpoints have different audiences:

* ``GET /``           → admin-only (exposes raw provider rows incl. masked key).
* ``GET /available``  → every authenticated user; the list is filtered down
                        to what each user is actually allowed to pick
                        (see ``allowed_models`` on the User model).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.database import get_db
from app.models_config.models import ModelProvider
from app.models_config.provider import ProviderError, model_router
from app.models_config.schemas import (
    AvailableModel,
    ProviderCreate,
    ProviderResponse,
    ProviderUpdate,
    TestConnectionResponse,
)
from app.models_config.service import encrypt_api_key, provider_to_response

router = APIRouter()

# Phase 2b constraint: only OpenRouter is wired up end-to-end.
SUPPORTED_TYPES_PHASE_2B = {"openrouter"}


async def _get_owned_provider(
    provider_id: uuid.UUID, user: User, db: AsyncSession
) -> ModelProvider:
    """Admin-scoped fetch: admins see their own providers + system-wide rows."""
    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Provider not found")
    if provider.user_id is not None and provider.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Provider not found")
    return provider


# --------------------------------------------------------------------
# List (admin only)
# --------------------------------------------------------------------
@router.get("", response_model=list[ProviderResponse])
@router.get("/", response_model=list[ProviderResponse], include_in_schema=False)
async def list_providers(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> list[ProviderResponse]:
    result = await db.execute(
        select(ModelProvider)
        .where((ModelProvider.user_id == user.id) | (ModelProvider.user_id.is_(None)))
        .order_by(ModelProvider.created_at.desc())
    )
    return [provider_to_response(p) for p in result.scalars().all()]


# --------------------------------------------------------------------
# Create (admin only)
# --------------------------------------------------------------------
@router.post("/providers", response_model=ProviderResponse, status_code=status.HTTP_201_CREATED)
async def create_provider(
    payload: ProviderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> ProviderResponse:
    if payload.type not in SUPPORTED_TYPES_PHASE_2B:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider type {payload.type!r} is not supported yet. "
                   f"Currently supported: {sorted(SUPPORTED_TYPES_PHASE_2B)}",
        )

    provider = ModelProvider(
        user_id=user.id,
        name=payload.name,
        type=payload.type,
        base_url=str(payload.base_url) if payload.base_url else None,
        api_key=encrypt_api_key(payload.api_key),
        enabled=payload.enabled,
        models=[m.model_dump() for m in payload.models],
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider)

    # If the caller didn't supply a curated model list, fetch the live catalog
    # so the UI has something to pick from immediately.
    if not provider.models:
        try:
            catalog = await model_router.list_models(provider)
            provider.models = catalog
            await db.commit()
            await db.refresh(provider)
        except ProviderError:
            # Non-fatal — UI can retry via /test or /fetch-models later.
            pass

    return provider_to_response(provider)


# --------------------------------------------------------------------
# Update (admin only)
# --------------------------------------------------------------------
@router.patch("/providers/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: uuid.UUID,
    payload: ProviderUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> ProviderResponse:
    provider = await _get_owned_provider(provider_id, user, db)

    if payload.name is not None:
        provider.name = payload.name
    if payload.base_url is not None:
        provider.base_url = str(payload.base_url)
    if payload.api_key is not None:
        if payload.api_key.strip() == "":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="api_key cannot be blank — omit the field to leave unchanged",
            )
        provider.api_key = encrypt_api_key(payload.api_key)
    if payload.enabled is not None:
        provider.enabled = payload.enabled
    if payload.models is not None:
        provider.models = [m.model_dump() for m in payload.models]
    # Distinguish "omitted" (leave unchanged) from "explicit null" (reset to
    # all-enabled) by inspecting what the caller actually sent. Omit → field
    # not in model_fields_set; null → field present with None value.
    if "enabled_models" in payload.model_fields_set:
        # Deduplicate + preserve order; `None` explicitly clears the whitelist.
        if payload.enabled_models is None:
            provider.enabled_models = None
        else:
            seen: set[str] = set()
            provider.enabled_models = [
                m for m in payload.enabled_models if not (m in seen or seen.add(m))
            ]

    await db.commit()
    await db.refresh(provider)
    return provider_to_response(provider)


# --------------------------------------------------------------------
# Delete (admin only)
# --------------------------------------------------------------------
@router.delete(
    "/providers/{provider_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_provider(
    provider_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> Response:
    provider = await _get_owned_provider(provider_id, user, db)
    if provider.user_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="System-wide providers cannot be deleted",
        )
    await db.delete(provider)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Test connection (admin only)
# --------------------------------------------------------------------
@router.post("/providers/{provider_id}/test", response_model=TestConnectionResponse)
async def test_provider(
    provider_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> TestConnectionResponse:
    provider = await _get_owned_provider(provider_id, user, db)
    result = await model_router.test_connection(provider)
    return TestConnectionResponse(**result)


# --------------------------------------------------------------------
# Refresh model catalog (admin only)
# --------------------------------------------------------------------
@router.post("/providers/{provider_id}/fetch-models", response_model=ProviderResponse)
async def fetch_provider_models(
    provider_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> ProviderResponse:
    provider = await _get_owned_provider(provider_id, user, db)
    try:
        catalog = await model_router.list_models(provider)
    except ProviderError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e)) from e

    provider.models = catalog
    await db.commit()
    await db.refresh(provider)
    return provider_to_response(provider)


# --------------------------------------------------------------------
# Flat list for the inline chat model dropdown (every authed user).
# --------------------------------------------------------------------
async def list_available_models_for(
    user: User, db: AsyncSession
) -> list[AvailableModel]:
    """Reusable form of :func:`available_models` for non-HTTP callers.

    The chat tool registry needs to enumerate the models a user can
    actually invoke (e.g. to pick an image-capable model for the
    ``generate_image`` tool) without a request scope. Both this
    function and the route handler share the same access-control logic
    so the tool path can never expose a model the user couldn't pick
    from the dropdown.
    """
    if user.role == "admin":
        provider_filter = (
            (ModelProvider.user_id == user.id) | (ModelProvider.user_id.is_(None))
        )
    else:
        # Providers owned by any admin are shared with regular users. We
        # intentionally don't look up admin user IDs separately — a subquery
        # keeps the set correct even if admins are added/demoted.
        admin_ids_subq = select(User.id).where(User.role == "admin").scalar_subquery()
        provider_filter = (
            ModelProvider.user_id.in_(admin_ids_subq)
            | ModelProvider.user_id.is_(None)
        )

    result = await db.execute(
        select(ModelProvider)
        .where(provider_filter & (ModelProvider.enabled.is_(True)))
        .order_by(ModelProvider.name)
    )

    user_allow: set[str] | None = (
        set(user.allowed_models)
        if user.role != "admin" and user.allowed_models is not None
        else None
    )

    flat: list[AvailableModel] = []
    for provider in result.scalars().all():
        # When the admin hasn't curated a list on this provider, every model
        # is in the org-wide pool; otherwise only whitelisted IDs are.
        provider_allow: set[str] | None = (
            set(provider.enabled_models) if provider.enabled_models is not None else None
        )
        for m in provider.models or []:
            model_id = m["id"]
            if provider_allow is not None and model_id not in provider_allow:
                continue
            if user_allow is not None and model_id not in user_allow:
                continue
            flat.append(
                AvailableModel(
                    provider_id=provider.id,
                    provider_name=provider.name,
                    provider_type=provider.type,  # type: ignore[arg-type]
                    model_id=model_id,
                    display_name=m.get("display_name") or model_id,
                    context_window=m.get("context_window"),
                    supports_vision=bool(m.get("supports_vision", False)),
                    supports_image_output=bool(
                        m.get("supports_image_output", False)
                    ),
                )
            )
    return flat


@router.get("/available", response_model=list[AvailableModel])
async def available_models(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AvailableModel]:
    """Return the flat list of models the caller may pick from in chat.

    * Admin:       every model from their own providers + system-wide.
    * Normal user: every model from providers owned by any admin + system-wide,
                   intersected with the user's ``allowed_models`` (NULL ⇒ no
                   intersection, i.e. full access to the admin pool).
    """
    return await list_available_models_for(user, db)

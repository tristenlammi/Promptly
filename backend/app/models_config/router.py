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
from app.custom_models.embedding import is_embedding_model_id
from app.database import get_db
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    KEYLESS_PROVIDER_TYPES,
    SUPPORTED_PROVIDER_TYPES,
    ProviderError,
    model_router,
)
from app.models_config.schemas import (
    AvailableModel,
    ProviderCreate,
    ProviderResponse,
    ProviderUpdate,
    TestConnectionResponse,
)
from app.models_config.service import encrypt_api_key, provider_to_response

router = APIRouter()


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
    if payload.type not in SUPPORTED_PROVIDER_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Provider type {payload.type!r} is not supported. "
                f"Supported: {sorted(SUPPORTED_PROVIDER_TYPES)}"
            ),
        )

    # Keyless providers (Ollama) may omit ``api_key``; everyone else
    # must supply one. We enforce it here rather than in the Pydantic
    # schema so the error message is type-aware.
    api_key_plain = (payload.api_key or "").strip()
    if not api_key_plain and payload.type not in KEYLESS_PROVIDER_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider type {payload.type!r} requires an api_key",
        )

    provider = ModelProvider(
        user_id=user.id,
        name=payload.name,
        type=payload.type,
        base_url=str(payload.base_url) if payload.base_url else None,
        api_key=encrypt_api_key(api_key_plain) if api_key_plain else None,
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

    Custom Models (admin-curated wrappers that add personality + a
    RAG knowledge base on top of a base model) are appended as first-
    class ``AvailableModel`` rows with ``is_custom=True`` and a
    synthetic ``custom:<uuid>`` ``model_id``. The picker, default-
    model preference, and per-conversation storage all keep working
    against the existing ``(provider_id, model_id)`` contract — only
    the chat dispatcher has to know to resolve the synthetic id
    back to its underlying base model before streaming.
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
            # Embedding-only models live in the same provider catalog
            # (they're registered so the Custom Models RAG pipeline can
            # resolve them) but they can't run chat completions. Hide
            # them from the picker — both when explicitly tagged and
            # when the id matches a known embedding name pattern, so
            # auto-discovered Ollama models (``nomic-embed-text``,
            # ``bge-m3``, etc.) don't leak through either.
            if m.get("kind") == "embedding":
                continue
            if is_embedding_model_id(model_id):
                continue
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

    # ------------------------------------------------------------------
    # Append Custom Models as synthetic entries.
    #
    # Lookup strategy:
    #   * Build a ``provider_id → ModelProvider`` map from the list we
    #     already fetched above so we can attach the real ``provider_name``
    #     / ``provider_type`` to each custom row without a second DB
    #     round trip for the common case.
    #   * A CustomModel whose base provider isn't in the user's allowed
    #     set is silently filtered out — the admin might have attached
    #     a power-user provider that regular users aren't meant to use.
    # ------------------------------------------------------------------
    from app.custom_models.models import CustomModel  # local import: avoids cycle

    # The provider loop above already iterated ``result`` — re-run the
    # same query to build a ``provider_id → ModelProvider`` map for
    # the custom-row annotation loop. Cheaper than restructuring the
    # function to keep both shapes in a single pass, and keeps this
    # block a pure add-on that can be removed cleanly.
    refetch = await db.execute(
        select(ModelProvider)
        .where(provider_filter & (ModelProvider.enabled.is_(True)))
    )
    allowed_provider_map = {p.id: p for p in refetch.scalars().all()}

    custom_rows = (
        await db.execute(
            select(CustomModel).order_by(CustomModel.display_name)
        )
    ).scalars().all()

    for cm in custom_rows:
        base_provider = allowed_provider_map.get(cm.base_provider_id)
        if base_provider is None:
            # Admin curated a custom model whose base provider isn't
            # visible to this user — skip rather than surface an
            # "Unknown provider" entry in the dropdown.
            continue
        # Respect the admin's enabled_models whitelist on the base
        # provider too — if the underlying model isn't picker-visible,
        # neither is the custom wrapper.
        provider_allow = (
            set(base_provider.enabled_models)
            if base_provider.enabled_models is not None
            else None
        )
        if provider_allow is not None and cm.base_model_id not in provider_allow:
            continue
        if user_allow is not None and cm.base_model_id not in user_allow:
            continue

        # Capture the base display name so the frontend ModelSelector
        # can render "custom chip + subtitle" without a second fetch.
        base_entry = next(
            (m for m in (base_provider.models or []) if m.get("id") == cm.base_model_id),
            None,
        )
        base_label = (
            (base_entry or {}).get("display_name") or cm.base_model_id
        )
        flat.append(
            AvailableModel(
                provider_id=base_provider.id,
                provider_name=base_provider.name,
                provider_type=base_provider.type,  # type: ignore[arg-type]
                model_id=f"custom:{cm.id}",
                display_name=cm.display_name,
                context_window=(base_entry or {}).get("context_window"),
                supports_vision=bool((base_entry or {}).get("supports_vision", False)),
                supports_image_output=bool(
                    (base_entry or {}).get("supports_image_output", False)
                ),
                is_custom=True,
                custom_model_id=cm.id,
                base_display_name=base_label,
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

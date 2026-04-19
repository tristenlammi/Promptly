"""Search providers API — CRUD + manual search (diagnostic)."""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.search.models import SearchProvider
from app.search.providers import SearchError, run_search
from app.search.schemas import (
    SearchProviderCreate,
    SearchProviderResponse,
    SearchProviderUpdate,
    SearchResponse,
    SearchRunRequest,
)
from app.search.service import (
    encrypt_config_secrets,
    masked_config,
    pick_search_provider,
)

logger = logging.getLogger("promptly.search")
router = APIRouter()


def _to_response(provider: SearchProvider) -> SearchProviderResponse:
    return SearchProviderResponse(
        id=provider.id,
        name=provider.name,
        type=provider.type,  # type: ignore[arg-type]
        config=masked_config(provider.config or {}),
        is_default=provider.is_default,
        enabled=provider.enabled,
        created_at=provider.created_at,
    )


async def _get_visible(
    provider_id: uuid.UUID, user: User, db: AsyncSession
) -> SearchProvider:
    sp = await db.get(SearchProvider, provider_id)
    if sp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Provider not found")
    if sp.user_id is not None and sp.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Provider not found")
    return sp


async def _clear_other_defaults(
    db: AsyncSession, user_id: uuid.UUID | None, keep_id: uuid.UUID
) -> None:
    """Ensure only one row is marked `is_default` per scope (user or system)."""
    others = await db.execute(
        select(SearchProvider).where(
            and_(
                SearchProvider.is_default.is_(True),
                SearchProvider.id != keep_id,
                SearchProvider.user_id.is_(None) if user_id is None
                else (SearchProvider.user_id == user_id),
            )
        )
    )
    for other in others.scalars().all():
        other.is_default = False


# --------------------------------------------------------------------
# List
# --------------------------------------------------------------------
@router.get("/providers", response_model=list[SearchProviderResponse])
async def list_providers(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SearchProviderResponse]:
    result = await db.execute(
        select(SearchProvider)
        .where(or_(SearchProvider.user_id == user.id, SearchProvider.user_id.is_(None)))
        .order_by(SearchProvider.is_default.desc(), SearchProvider.created_at.desc())
    )
    return [_to_response(p) for p in result.scalars().all()]


# --------------------------------------------------------------------
# Create
# --------------------------------------------------------------------
@router.post(
    "/providers",
    response_model=SearchProviderResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_provider(
    payload: SearchProviderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SearchProviderResponse:
    sp = SearchProvider(
        user_id=user.id,
        name=payload.name,
        type=payload.type,
        config=encrypt_config_secrets(payload.config),
        is_default=payload.is_default,
        enabled=payload.enabled,
    )
    db.add(sp)
    await db.flush()

    if payload.is_default:
        await _clear_other_defaults(db, user.id, sp.id)

    await db.commit()
    await db.refresh(sp)
    return _to_response(sp)


# --------------------------------------------------------------------
# Update
# --------------------------------------------------------------------
@router.patch("/providers/{provider_id}", response_model=SearchProviderResponse)
async def update_provider(
    provider_id: uuid.UUID,
    payload: SearchProviderUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SearchProviderResponse:
    sp = await _get_visible(provider_id, user, db)
    if sp.user_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="System-wide providers can't be modified — create a user-scoped override instead.",
        )

    if payload.name is not None:
        sp.name = payload.name
    if payload.enabled is not None:
        sp.enabled = payload.enabled
    if payload.config is not None:
        # Merge: keep any existing api_key if caller omitted one.
        merged = dict(sp.config or {})
        incoming = encrypt_config_secrets(payload.config)
        for k, v in incoming.items():
            merged[k] = v
        # If the caller sent api_key="" deliberately, drop it.
        if payload.config.get("api_key") == "":
            merged.pop("api_key", None)
        sp.config = merged
    if payload.is_default is not None:
        sp.is_default = payload.is_default
        if payload.is_default:
            await _clear_other_defaults(db, sp.user_id, sp.id)

    await db.commit()
    await db.refresh(sp)
    return _to_response(sp)


# --------------------------------------------------------------------
# Delete
# --------------------------------------------------------------------
@router.delete(
    "/providers/{provider_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_provider(
    provider_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    sp = await _get_visible(provider_id, user, db)
    if sp.user_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="System-wide providers cannot be deleted by regular users",
        )
    await db.delete(sp)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Run search (diagnostic / manual use)
# --------------------------------------------------------------------
@router.post("/run", response_model=SearchResponse)
async def run_search_endpoint(
    payload: SearchRunRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SearchResponse:
    sp = await pick_search_provider(db, user, provider_id=payload.provider_id)
    if sp is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No enabled search provider available",
        )
    try:
        results = await run_search(sp, payload.query, count=payload.count)
    except SearchError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e)) from e

    return SearchResponse(
        query=payload.query,
        provider=f"{sp.name} ({sp.type})",
        results=results,
    )


@router.get("/_ping")
async def ping() -> dict[str, str]:
    return {"module": "search", "status": "ready"}

"""Search providers API — CRUD + manual search (diagnostic)."""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.search.models import SearchProvider
from app.search.providers import SearchError, run_search
from app.search.schemas import (
    SearchProviderCreate,
    SearchProviderReorder,
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
        position=provider.position,
        cooldown_until=provider.cooldown_until,
        last_error=provider.last_error,
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
        # Failover order: position first (the admin-arranged chain), then
        # created_at as a stable tiebreak for equal positions.
        .order_by(SearchProvider.position.asc(), SearchProvider.created_at.asc())
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
    # ``system`` scope (user_id NULL) = instance-wide: visible to every
    # account and eligible as the system default + failover candidate.
    # Admin-only, since it changes search behaviour for all users.
    owner_id: uuid.UUID | None = user.id
    if payload.scope == "system":
        if not user.is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only admins can create system-wide search providers.",
            )
        owner_id = None

    # New providers land at the bottom of the failover chain (highest
    # position); the admin reorders from there.
    max_pos = (
        await db.execute(
            select(func.max(SearchProvider.position)).where(
                or_(
                    SearchProvider.user_id == user.id,
                    SearchProvider.user_id.is_(None),
                )
            )
        )
    ).scalar()
    next_pos = (max_pos + 1) if max_pos is not None else 0

    sp = SearchProvider(
        user_id=owner_id,
        name=payload.name,
        type=payload.type,
        config=encrypt_config_secrets(payload.config),
        is_default=payload.is_default,
        enabled=payload.enabled,
        position=next_pos,
    )
    db.add(sp)
    await db.flush()

    if payload.is_default:
        await _clear_other_defaults(db, owner_id, sp.id)

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
    if sp.user_id is None and not user.is_admin:
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
    if sp.user_id is None and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="System-wide providers cannot be deleted by regular users",
        )
    await db.delete(sp)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Reorder the failover chain (admin)
# --------------------------------------------------------------------
@router.post("/providers/reorder", response_model=list[SearchProviderResponse])
async def reorder_providers(
    payload: SearchProviderReorder,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SearchProviderResponse]:
    """Set the failover order — providers get ``position`` by list index."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can reorder the search chain.",
        )
    rows = (
        (
            await db.execute(
                select(SearchProvider).where(
                    or_(
                        SearchProvider.user_id == user.id,
                        SearchProvider.user_id.is_(None),
                    )
                )
            )
        )
        .scalars()
        .all()
    )
    by_id = {sp.id: sp for sp in rows}
    for index, pid in enumerate(payload.order):
        sp = by_id.get(pid)
        if sp is not None:
            sp.position = index
            # The top of the chain is the effective default; keep the badge
            # in sync (and clear it elsewhere) so is_default never contradicts
            # the order.
            sp.is_default = index == 0
    await db.commit()
    result = await db.execute(
        select(SearchProvider)
        .where(or_(SearchProvider.user_id == user.id, SearchProvider.user_id.is_(None)))
        .order_by(SearchProvider.position.asc(), SearchProvider.created_at.asc())
    )
    return [_to_response(p) for p in result.scalars().all()]


# --------------------------------------------------------------------
# Resume a paused provider (admin) — clears the auto-backoff
# --------------------------------------------------------------------
@router.post("/providers/{provider_id}/resume", response_model=SearchProviderResponse)
async def resume_provider(
    provider_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SearchProviderResponse:
    sp = await _get_visible(provider_id, user, db)
    if sp.user_id is None and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can resume a system provider.",
        )
    sp.cooldown_until = None
    sp.last_error = None
    await db.commit()
    await db.refresh(sp)
    return _to_response(sp)


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

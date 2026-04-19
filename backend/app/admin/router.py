"""Admin API — user management + the model pool the admin can assign from.

All endpoints here require ``role == "admin"`` via ``require_admin``.
Non-admin callers get a 403.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import (
    AdminModelOption,
    AdminUserCreate,
    AdminUserResponse,
    AdminUserUpdate,
    AdminUserUsageDay,
    AdminUserUsageResponse,
    AuthEventResponse,
    PasswordResetRequest,
)
from app.auth.audit import (
    EVENT_DISABLE,
    EVENT_ENABLE,
    EVENT_FORCE_LOGOUT_ALL,
    EVENT_PASSWORD_RESET_BY_ADMIN,
    EVENT_UNLOCK,
    record_event,
    safe_dict,
)
from app.auth.deps import require_admin
from app.auth.events import AuthEvent
from app.auth.models import User
from app.auth.utils import hash_password
from app.billing.usage import check_budget
from app.database import get_db
from app.files.quota import get_quota
from app.files.system_folders import seed_system_folders
from app.models_config.models import ModelProvider

router = APIRouter()

# Analytics + observability live in their own modules to keep this
# file focused on user/account management. Both routers share the
# same admin auth gating and get nested under ``/api/admin``.
from app.admin.analytics import router as _analytics_router  # noqa: E402
from app.admin.observability_router import router as _observability_router  # noqa: E402

router.include_router(_analytics_router)
router.include_router(_observability_router)


# --------------------------------------------------------------------
# Users
# --------------------------------------------------------------------
@router.get("/users", response_model=list[AdminUserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminUserResponse]:
    result = await db.execute(select(User).order_by(User.created_at.asc()))
    return [AdminUserResponse.model_validate(u) for u in result.scalars().all()]


@router.post(
    "/users",
    response_model=AdminUserResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_user(
    payload: AdminUserCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminUserResponse:
    user = User(
        email=payload.email.lower(),
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        allowed_models=_clean_allowed_models(payload.allowed_models),
        settings={},
        storage_cap_bytes=payload.storage_cap_bytes,
        daily_token_budget=payload.daily_token_budget,
        monthly_token_budget=payload.monthly_token_budget,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username already exists",
        ) from e
    await db.refresh(user)
    # Materialise the system folders (Chat Uploads / Generated Files / ...)
    # right away so the new account opens to a populated Files page instead
    # of an empty one. Runs in its own commit so a folder-creation glitch
    # never blocks the user being created.
    await seed_system_folders(db, user)
    await db.commit()
    return AdminUserResponse.model_validate(user)


@router.patch("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: uuid.UUID,
    payload: AdminUserUpdate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminUserResponse:
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    fields = payload.model_fields_set

    # Self-safety: admins cannot demote themselves and lose access to the
    # admin panel in one click. They can always demote a *different* admin.
    if "role" in fields and payload.role is not None:
        if target.id == actor.id and payload.role != "admin":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot demote yourself. Ask another admin to do it.",
            )
        target.role = payload.role
        # Admins have no model restriction — clear any stale allowlist.
        if payload.role == "admin":
            target.allowed_models = None

    if "email" in fields and payload.email is not None:
        target.email = payload.email.lower()
    if "username" in fields and payload.username is not None:
        target.username = payload.username
    if "password" in fields and payload.password is not None:
        # Admin-initiated password change: kill any active session for
        # the target user and force a password-change on next login.
        # Audit row tracked by the dedicated /reset-password endpoint;
        # PATCH callers get a generic admin-edit trail via auth_events.
        target.password_hash = hash_password(payload.password)
        target.must_change_password = True
        target.token_version = (target.token_version or 0) + 1

    if "allowed_models" in fields:
        # Admins ignore allowed_models entirely; don't let a PATCH from the UI
        # write a stale list to an admin row.
        if target.role == "admin":
            target.allowed_models = None
        else:
            target.allowed_models = _clean_allowed_models(payload.allowed_models)

    # Quota overrides — same tri-state convention as ``allowed_models``.
    # ``omitted`` (not in fields) leaves the existing value alone, so an
    # admin-set cap survives an unrelated email change. Explicit
    # ``null`` clears the override and reverts the user to whatever the
    # org-wide default in ``app_settings`` says.
    if "storage_cap_bytes" in fields:
        target.storage_cap_bytes = payload.storage_cap_bytes
    if "daily_token_budget" in fields:
        target.daily_token_budget = payload.daily_token_budget
    if "monthly_token_budget" in fields:
        target.monthly_token_budget = payload.monthly_token_budget

    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username already exists",
        ) from e
    await db.refresh(target)
    return AdminUserResponse.model_validate(target)


@router.delete(
    "/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> Response:
    if user_id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account.",
        )
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    await db.delete(target)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------
# Model pool — what the admin can pick from when assigning access
# --------------------------------------------------------------------
@router.get("/model-pool", response_model=list[AdminModelOption])
async def model_pool(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> list[AdminModelOption]:
    """The flat list of models available for per-user assignment.

    This is the *org-wide* pool — every model that is currently surfaced by
    any enabled provider, honoring each provider's ``enabled_models``
    curation. Admins own the providers, so we scope to providers visible to
    the acting admin (owned by them OR system-wide with ``user_id = NULL``).
    """
    result = await db.execute(
        select(ModelProvider)
        .where(
            ((ModelProvider.user_id == actor.id) | (ModelProvider.user_id.is_(None)))
            & (ModelProvider.enabled.is_(True))
        )
        .order_by(ModelProvider.name)
    )
    rows: list[AdminModelOption] = []
    seen: set[str] = set()
    for provider in result.scalars().all():
        allow: set[str] | None = (
            set(provider.enabled_models) if provider.enabled_models is not None else None
        )
        for m in provider.models or []:
            model_id = m["id"]
            if allow is not None and model_id not in allow:
                continue
            # De-dupe by model_id across providers — if OpenRouter + OpenAI
            # both surface "gpt-4o-mini" we only need one entry to assign.
            if model_id in seen:
                continue
            seen.add(model_id)
            rows.append(
                AdminModelOption(
                    provider_id=provider.id,
                    provider_name=provider.name,
                    model_id=model_id,
                    display_name=m.get("display_name") or model_id,
                    context_window=m.get("context_window"),
                )
            )
    return rows


# --------------------------------------------------------------------
# Account security actions
# --------------------------------------------------------------------
async def _load_target(user_id: uuid.UUID, db: AsyncSession) -> User:
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return target


@router.get("/users/locked", response_model=list[AdminUserResponse])
async def list_locked_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminUserResponse]:
    """Convenience: only the accounts that are currently locked.

    The full ``GET /users`` response also exposes ``locked_at``, but
    surfacing this as its own endpoint lets the admin UI render a
    "Needs your attention" badge without filtering client-side.
    """
    rows = await db.execute(
        select(User)
        .where(User.locked_at.is_not(None))
        .order_by(User.locked_at.desc())
    )
    return [AdminUserResponse.model_validate(u) for u in rows.scalars().all()]


@router.post("/users/{user_id}/unlock", response_model=AdminUserResponse)
async def unlock_user(
    user_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminUserResponse:
    """Clear the lockout state and reset the failed-attempt counter.

    Idempotent — calling this on a non-locked account is a no-op except
    for the audit row (admins may want to call it after manually
    investigating an account).
    """
    target = await _load_target(user_id, db)
    was_locked = target.locked_at is not None
    target.locked_at = None
    target.failed_login_attempts = 0
    await record_event(
        db,
        request=request,
        event_type=EVENT_UNLOCK,
        user_id=target.id,
        identifier=target.username,
        detail=safe_dict(
            {"by_admin": str(actor.id), "was_locked": was_locked}
        ),
    )
    await db.commit()
    await db.refresh(target)
    return AdminUserResponse.model_validate(target)


@router.post("/users/{user_id}/disable", response_model=AdminUserResponse)
async def disable_user(
    user_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminUserResponse:
    """Hard-disable an account.

    Disabled accounts are refused at login *and* at every authenticated
    request (the dependency rejects the JWT before any handler runs).
    Token version is bumped so any in-flight session is killed
    immediately.
    """
    if user_id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot disable your own account.",
        )
    target = await _load_target(user_id, db)
    target.disabled = True
    target.token_version = (target.token_version or 0) + 1
    await record_event(
        db,
        request=request,
        event_type=EVENT_DISABLE,
        user_id=target.id,
        identifier=target.username,
        detail=safe_dict({"by_admin": str(actor.id)}),
    )
    await db.commit()
    await db.refresh(target)
    return AdminUserResponse.model_validate(target)


@router.post("/users/{user_id}/enable", response_model=AdminUserResponse)
async def enable_user(
    user_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminUserResponse:
    """Reverse a disable. Does *not* unlock — call /unlock for that."""
    target = await _load_target(user_id, db)
    target.disabled = False
    await record_event(
        db,
        request=request,
        event_type=EVENT_ENABLE,
        user_id=target.id,
        identifier=target.username,
        detail=safe_dict({"by_admin": str(actor.id)}),
    )
    await db.commit()
    await db.refresh(target)
    return AdminUserResponse.model_validate(target)


@router.post("/users/{user_id}/logout-everywhere", response_model=AdminUserResponse)
async def force_logout_everywhere(
    user_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminUserResponse:
    """Bump ``token_version`` so every outstanding JWT for the user fails.

    Useful after an admin suspects credential compromise but doesn't
    want to fully disable the account. The user will need to log in
    again from scratch.
    """
    target = await _load_target(user_id, db)
    target.token_version = (target.token_version or 0) + 1
    await record_event(
        db,
        request=request,
        event_type=EVENT_FORCE_LOGOUT_ALL,
        user_id=target.id,
        identifier=target.username,
        detail=safe_dict({"by_admin": str(actor.id)}),
    )
    await db.commit()
    await db.refresh(target)
    return AdminUserResponse.model_validate(target)


@router.post("/users/{user_id}/reset-password", response_model=AdminUserResponse)
async def reset_password(
    user_id: uuid.UUID,
    payload: PasswordResetRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminUserResponse:
    """Set a new password and force the user to change it on next login.

    Token version is bumped so any active session is invalidated. The
    plaintext is never written to the audit log — only the fact that a
    reset happened, by which admin.
    """
    target = await _load_target(user_id, db)
    target.password_hash = hash_password(payload.password)
    target.must_change_password = True
    target.token_version = (target.token_version or 0) + 1
    await record_event(
        db,
        request=request,
        event_type=EVENT_PASSWORD_RESET_BY_ADMIN,
        user_id=target.id,
        identifier=target.username,
        detail=safe_dict({"by_admin": str(actor.id)}),
    )
    await db.commit()
    await db.refresh(target)
    return AdminUserResponse.model_validate(target)


# --------------------------------------------------------------------
# Per-user usage / quota snapshot
# --------------------------------------------------------------------
@router.get(
    "/users/{user_id}/usage",
    response_model=AdminUserUsageResponse,
)
async def user_usage(
    user_id: uuid.UUID,
    days: int = Query(default=30, ge=1, le=180),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminUserUsageResponse:
    """Daily usage rollup + current quota snapshot for one user.

    Powers the admin "Usage" tab. ``days`` bounds the recent-history
    list so a year-old account doesn't ship 365 rows in a single
    response — 30 days is plenty for the bar chart we render and
    keeps payload size sane.
    """
    target = await _load_target(user_id, db)

    # ``check_budget`` already does the daily/monthly aggregation
    # using the same indexed queries the chat hot path uses, so we
    # piggy-back on it instead of reimplementing the math.
    snapshot = await check_budget(db, target)
    storage_quota = await get_quota(db, target)

    # History — newest first so the UI can lop off the tail without
    # reversing client-side. Imported lazily to keep the admin
    # router from pulling in ``UsageDaily`` at module load.
    from app.billing.models import UsageDaily  # noqa: PLC0415

    rows = (
        await db.execute(
            select(UsageDaily)
            .where(UsageDaily.user_id == target.id)
            .order_by(UsageDaily.day.desc())
            .limit(days)
        )
    ).scalars().all()
    history = [
        AdminUserUsageDay(
            day=datetime.combine(r.day, datetime.min.time()),
            prompt_tokens=r.prompt_tokens or 0,
            completion_tokens=r.completion_tokens or 0,
            messages_sent=r.messages_sent or 0,
        )
        for r in rows
    ]

    return AdminUserUsageResponse(
        daily_used=snapshot.daily_used,
        daily_cap=snapshot.daily_cap,
        monthly_used=snapshot.monthly_used,
        monthly_cap=snapshot.monthly_cap,
        storage_used_bytes=storage_quota.used_bytes,
        storage_cap_bytes=storage_quota.cap_bytes,
        history=history,
    )


# --------------------------------------------------------------------
# Audit log
# --------------------------------------------------------------------
@router.get("/auth-events", response_model=list[AuthEventResponse])
async def list_auth_events(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
    user_id: uuid.UUID | None = Query(default=None),
    event_type: str | None = Query(default=None, max_length=48),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[AuthEventResponse]:
    """Paginated audit log, newest first.

    Optional filters by user_id (drill down on one account) or
    event_type (e.g. only ``login_fail`` to investigate brute force).
    Hard-capped at 500 rows per page so the JSON payload stays
    manageable in the admin UI.
    """
    stmt = select(AuthEvent).order_by(AuthEvent.created_at.desc())
    if user_id is not None:
        stmt = stmt.where(AuthEvent.user_id == user_id)
    if event_type:
        stmt = stmt.where(AuthEvent.event_type == event_type)
    stmt = stmt.offset(offset).limit(limit)
    rows = await db.execute(stmt)
    return [AuthEventResponse.model_validate(e) for e in rows.scalars().all()]


# --------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------
def _clean_allowed_models(value: list[str] | None) -> list[str] | None:
    """Deduplicate + preserve order. ``None`` passes through (full access)."""
    if value is None:
        return None
    seen: set[str] = set()
    out: list[str] = []
    for m in value:
        if m and m not in seen:
            seen.add(m)
            out.append(m)
    return out

"""HTTP surface for the Web Push notifications feature.

Endpoints (mounted under ``/api/notifications``):

* ``GET  /public-key``          — VAPID application-server key so the
  frontend can ``pushManager.subscribe`` with it.
* ``GET  /subscriptions``       — list the caller's registered
  browsers / devices.
* ``POST /subscriptions``       — register a new device (idempotent
  via the ``(user_id, endpoint)`` unique constraint).
* ``PATCH /subscriptions/{id}`` — rename a device.
* ``DELETE /subscriptions/{id}``— unsubscribe one device.
* ``GET  /preferences``         — read per-user category toggles.
* ``PATCH /preferences``        — update one or more toggles.
* ``POST /test``                — fire a diagnostic push to every
  active subscription on the caller. Bypasses the per-category
  toggles (still honours the master switch) so the user can always
  confirm the round-trip works."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.notifications.dispatch import notify_user
from app.notifications.models import PushPreferences, PushSubscription
from app.notifications.schemas import (
    PreferencesSchema,
    PreferencesUpdate,
    PublicKeyResponse,
    SubscribePayload,
    SubscriptionSummary,
    SubscriptionUpdate,
    TestPushResponse,
)

logger = logging.getLogger("promptly.notifications.router")

router = APIRouter()


# ---------------------------------------------------------------------
# VAPID public key
# ---------------------------------------------------------------------


@router.get("/public-key", response_model=PublicKeyResponse)
async def get_public_key(
    db: AsyncSession = Depends(get_db),
) -> PublicKeyResponse:
    """Return the server's VAPID application-server key.

    Reads from the ``app_settings`` row, where the bootstrap
    auto-generates a keypair on first boot if none was pre-set. 503
    only if both DB and env are empty (which shouldn't happen on a
    healthy install — see ``provision_vapid_keys``); the frontend uses
    the 503 to hide the Subscribe button and show a "ask your admin to
    set up push" hint instead of silently failing.
    """
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    public_key = row.vapid_public_key if row else None
    if not public_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Push notifications aren't configured on this server.",
        )
    return PublicKeyResponse(public_key=public_key)


# ---------------------------------------------------------------------
# Subscriptions
# ---------------------------------------------------------------------


@router.get("/subscriptions", response_model=list[SubscriptionSummary])
async def list_subscriptions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SubscriptionSummary]:
    rows = (
        (
            await db.execute(
                select(PushSubscription)
                .where(PushSubscription.user_id == user.id)
                .order_by(PushSubscription.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [SubscriptionSummary.model_validate(r) for r in rows]


@router.post(
    "/subscriptions",
    response_model=SubscriptionSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_subscription(
    payload: SubscribePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SubscriptionSummary:
    """Register a new browser / device subscription.

    Idempotent: re-subscribing from the same browser (same endpoint)
    updates the existing row in place rather than creating a
    duplicate — otherwise a user who clicks "Enable" twice ends up
    receiving every notification twice.
    """
    p256dh = payload.keys.get("p256dh")
    auth = payload.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Subscription payload is missing p256dh / auth keys.",
        )

    user_agent = payload.user_agent or request.headers.get("user-agent")

    # Fast upsert — look first, update if found, else insert.
    existing = (
        await db.execute(
            select(PushSubscription).where(
                PushSubscription.user_id == user.id,
                PushSubscription.endpoint == payload.endpoint,
            )
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.p256dh = p256dh
        existing.auth = auth
        if user_agent:
            existing.user_agent = user_agent
        if payload.label:
            existing.label = payload.label
        existing.last_used_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        return SubscriptionSummary.model_validate(existing)

    row = PushSubscription(
        user_id=user.id,
        endpoint=payload.endpoint,
        p256dh=p256dh,
        auth=auth,
        user_agent=user_agent,
        label=payload.label,
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        # Lost the upsert race — someone else inserted the same
        # endpoint between our SELECT and INSERT. Recover cleanly.
        await db.rollback()
        row = (
            await db.execute(
                select(PushSubscription).where(
                    PushSubscription.user_id == user.id,
                    PushSubscription.endpoint == payload.endpoint,
                )
            )
        ).scalar_one()
    await db.refresh(row)
    return SubscriptionSummary.model_validate(row)


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionSummary)
async def update_subscription(
    sub_id: uuid.UUID,
    payload: SubscriptionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SubscriptionSummary:
    row = await db.get(PushSubscription, sub_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    data = payload.model_dump(exclude_unset=True)
    if "label" in data:
        row.label = data["label"]
    await db.commit()
    await db.refresh(row)
    return SubscriptionSummary.model_validate(row)


@router.delete(
    "/subscriptions/{sub_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_subscription(
    sub_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = await db.get(PushSubscription, sub_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------


async def _get_or_create_prefs(
    db: AsyncSession, user: User
) -> PushPreferences:
    row = await db.get(PushPreferences, user.id)
    if row is None:
        row = PushPreferences(user_id=user.id)
        db.add(row)
        await db.flush()
    return row


@router.get("/preferences", response_model=PreferencesSchema)
async def get_preferences(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PreferencesSchema:
    prefs = await _get_or_create_prefs(db, user)
    await db.commit()
    return PreferencesSchema.model_validate(prefs)


@router.patch("/preferences", response_model=PreferencesSchema)
async def update_preferences(
    payload: PreferencesUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PreferencesSchema:
    prefs = await _get_or_create_prefs(db, user)
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(prefs, key, value)
    await db.commit()
    await db.refresh(prefs)
    return PreferencesSchema.model_validate(prefs)


# ---------------------------------------------------------------------
# Test push
# ---------------------------------------------------------------------


@router.post("/test", response_model=TestPushResponse)
async def send_test_push(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TestPushResponse:
    """Fire a diagnostic push to every subscription on the caller.

    Returns how many subscriptions were targeted so the UI can show
    "sent to 2 devices — check your phone" as confirmation."""
    count = (
        await db.execute(
            select(PushSubscription).where(PushSubscription.user_id == user.id)
        )
    ).scalars().all()

    await notify_user(
        user_id=user.id,
        category="test",
        title="Promptly",
        body="Push notifications are set up correctly.",
        url="/account/security",
        tag="promptly-test",
    )
    return TestPushResponse(sent=len(count))


# ---------------------------------------------------------------------
# Admin endpoint to wipe all pushes for the current user (panic button)
# ---------------------------------------------------------------------


@router.delete("/subscriptions", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe_all(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """One-click "unsubscribe everything" for the Account page.

    Useful when the user has installed Promptly on half a dozen
    machines over the years and just wants a clean slate without
    renaming each device first."""
    await db.execute(
        delete(PushSubscription).where(PushSubscription.user_id == user.id)
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

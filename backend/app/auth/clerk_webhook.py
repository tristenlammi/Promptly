"""Clerk webhooks — keep the local shadow users in sync with Clerk.

Lazy-provisioning (in ``clerk.py``) creates a user on first sign-in; these
webhooks handle the rest: profile updates (email/username changes) and account
deletions, plus creating the shadow row up-front if Clerk fires ``user.created``
before the user's first request.

Signature verification is the Svix scheme Clerk uses (HMAC-SHA256 over
``{id}.{timestamp}.{body}``), implemented inline so we don't add a dependency.
The endpoint is inert unless ``AUTH_PROVIDER=clerk`` and a signing secret is set.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.clerk import (
    _unusable_password_hash,
    normalize_org_role,
    upsert_org,
)
from app.auth.models import Organization, User
from app.config import get_settings
from app.database import get_db

settings = get_settings()
router = APIRouter()

# Reject webhooks whose timestamp is outside this window (replay defence).
_TOLERANCE_SECONDS = 300


def _verify_svix(headers, body: bytes, secret: str) -> bool:
    """Verify a Svix (Clerk) webhook signature. ``headers`` is the request's
    case-insensitive header map; ``body`` is the raw request bytes."""
    svix_id = headers.get("svix-id")
    svix_ts = headers.get("svix-timestamp")
    svix_sig = headers.get("svix-signature")
    if not (svix_id and svix_ts and svix_sig and secret):
        return False
    try:
        if abs(time.time() - int(svix_ts)) > _TOLERANCE_SECONDS:
            return False
    except (TypeError, ValueError):
        return False

    key_b64 = secret[len("whsec_") :] if secret.startswith("whsec_") else secret
    try:
        key = base64.b64decode(key_b64)
    except (ValueError, TypeError):
        return False

    signed = f"{svix_id}.{svix_ts}.".encode() + body
    expected = base64.b64encode(
        hmac.new(key, signed, hashlib.sha256).digest()
    ).decode()
    # svix-signature is a space-separated list of ``v1,<sig>`` entries.
    for part in svix_sig.split():
        sig = part.split(",", 1)[1] if "," in part else part
        if hmac.compare_digest(sig, expected):
            return True
    return False


def _primary_email(data: dict) -> str:
    emails = data.get("email_addresses") or []
    primary_id = data.get("primary_email_address_id")
    for e in emails:
        if e.get("id") == primary_id:
            return (e.get("email_address") or "").strip().lower()
    if emails:
        return (emails[0].get("email_address") or "").strip().lower()
    return ""


async def _sync_user(data: dict, db: AsyncSession) -> None:
    """Create or update the shadow user for a Clerk ``user.created/updated``."""
    clerk_id = data.get("id")
    if not clerk_id:
        return
    email = _primary_email(data)
    username = (data.get("username") or "").strip()

    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_id)
    )
    user = result.scalar_one_or_none()
    if user is not None:
        changed = False
        if email and user.email != email:
            user.email = email
            changed = True
        if username and user.username != username:
            user.username = username
            changed = True
        if changed:
            try:
                await db.commit()
            except IntegrityError:
                # Colliding email/username — skip the rename rather than 500.
                await db.rollback()
        return

    # No row yet: link a matching (Clerk-verified) email, else create fresh.
    if email:
        result = await db.execute(select(User).where(User.email == email))
        existing = result.scalar_one_or_none()
        if existing is not None:
            existing.clerk_user_id = clerk_id
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()
            return

    short = clerk_id.replace("user_", "")[:24]
    new_user = User(
        email=email or f"{short}@clerk.local",
        username=username or f"clerk_{short}"[:64],
        password_hash=_unusable_password_hash(),
        clerk_user_id=clerk_id,
        role="user",
    )
    db.add(new_user)
    try:
        await db.commit()
    except IntegrityError:
        # Provisioned concurrently (e.g. first sign-in raced the webhook).
        await db.rollback()


async def _disable_user(data: dict, db: AsyncSession) -> None:
    """Deactivate the shadow user on a Clerk ``user.deleted``. We disable +
    bump ``token_version`` (kills live sessions) rather than hard-delete, so a
    deletion in Clerk never cascades away the user's workspaces/files."""
    clerk_id = data.get("id")
    if not clerk_id:
        return
    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_id)
    )
    user = result.scalar_one_or_none()
    if user is None:
        return
    user.disabled = True
    user.token_version = (user.token_version or 0) + 1
    await db.commit()


async def _sync_org(data: dict, db: AsyncSession) -> None:
    """organization.created / .updated → upsert the org shadow (name/id)."""
    clerk_org_id = data.get("id")
    if not clerk_org_id:
        return
    await upsert_org(clerk_org_id, data.get("name"), db)


async def _delete_org(data: dict, db: AsyncSession) -> None:
    """organization.deleted → drop the shadow (FK SET NULL clears members)."""
    clerk_org_id = data.get("id")
    if not clerk_org_id:
        return
    result = await db.execute(
        select(Organization).where(Organization.clerk_org_id == clerk_org_id)
    )
    org = result.scalar_one_or_none()
    if org is not None:
        await db.delete(org)
        await db.commit()


async def _sync_membership(data: dict, db: AsyncSession) -> None:
    """organizationMembership.created / .updated → set the member's org + role."""
    org_data = data.get("organization") or {}
    clerk_org_id = org_data.get("id")
    pud = data.get("public_user_data") or {}
    clerk_user_id = pud.get("user_id")
    if not (clerk_org_id and clerk_user_id):
        return
    org = await upsert_org(clerk_org_id, org_data.get("name"), db)
    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_user_id)
    )
    user = result.scalar_one_or_none()
    if user is None:
        # The user.created webhook hasn't landed yet — the token org-sync will
        # fill this in on their first authenticated request.
        return
    role = normalize_org_role(data.get("role"))
    changed = False
    if user.org_id != org.id:
        user.org_id = org.id
        changed = True
    if user.org_role != role:
        user.org_role = role
        changed = True
    if changed:
        await db.commit()


async def _remove_membership(data: dict, db: AsyncSession) -> None:
    """organizationMembership.deleted → detach the member from the org."""
    pud = data.get("public_user_data") or {}
    clerk_user_id = pud.get("user_id")
    if not clerk_user_id:
        return
    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_user_id)
    )
    user = result.scalar_one_or_none()
    if user is not None and user.org_id is not None:
        user.org_id = None
        user.org_role = None
        await db.commit()


@router.post("/webhook")
async def clerk_webhook(
    request: Request, db: AsyncSession = Depends(get_db)
) -> dict[str, bool]:
    # Inert unless Clerk auth is active with a configured signing secret.
    if (settings.AUTH_PROVIDER or "custom").lower() != "clerk":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if not settings.CLERK_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Clerk webhook secret not configured.",
        )

    body = await request.body()
    if not _verify_svix(request.headers, body, settings.CLERK_WEBHOOK_SECRET):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid webhook signature.",
        )
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON"
        ) from e

    event_type = payload.get("type", "")
    data = payload.get("data", {}) or {}
    if event_type in ("user.created", "user.updated"):
        await _sync_user(data, db)
    elif event_type == "user.deleted":
        await _disable_user(data, db)
    elif event_type in ("organization.created", "organization.updated"):
        await _sync_org(data, db)
    elif event_type == "organization.deleted":
        await _delete_org(data, db)
    elif event_type in (
        "organizationMembership.created",
        "organizationMembership.updated",
    ):
        await _sync_membership(data, db)
    elif event_type == "organizationMembership.deleted":
        await _remove_membership(data, db)
    # Ack all events (even unhandled types) so Clerk doesn't retry them.
    return {"received": True}

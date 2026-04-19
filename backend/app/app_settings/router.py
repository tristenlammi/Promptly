"""Admin-only API for the global ``app_settings`` row.

Endpoints
---------
GET  /api/admin/app-settings       → current values (passwords masked)
PATCH /api/admin/app-settings      → partial update

Security notes
--------------
* The SMTP password is Fernet-encrypted at rest using the same helpers
  that protect provider API keys (``app.auth.utils.encrypt_secret``).
* The plaintext password is *never* returned in a response — only a
  ``smtp_password_set`` boolean. To rotate the password the admin
  POSTs a new value; to clear it they POST an empty string.
* Every change writes an audit row with a redacted summary of the
  diff (the password value is never logged).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import AppSettingsResponse, AppSettingsUpdate
from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict
from app.auth.deps import require_admin
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.database import get_db

router = APIRouter()


def _to_response(row: AppSettings) -> AppSettingsResponse:
    """Build the admin-facing response without leaking the password."""
    return AppSettingsResponse(
        mfa_required=row.mfa_required,
        smtp_host=row.smtp_host,
        smtp_port=row.smtp_port,
        smtp_username=row.smtp_username,
        smtp_use_tls=row.smtp_use_tls,
        smtp_from_address=row.smtp_from_address,
        smtp_from_name=row.smtp_from_name,
        smtp_password_set=bool(row.smtp_password_encrypted),
        smtp_configured=row.smtp_configured,
        default_storage_cap_bytes=row.default_storage_cap_bytes,
        default_daily_token_budget=row.default_daily_token_budget,
        default_monthly_token_budget=row.default_monthly_token_budget,
        updated_at=row.updated_at,
    )


async def _load_settings(db: AsyncSession) -> AppSettings:
    """Fetch the singleton row, creating it on the fly if missing.

    The Alembic migration seeds it on first upgrade and bootstrap.py
    reseeds it on every container start, but this is a final
    belt-and-braces guard so the API never 500s on a fresh install.
    """
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


@router.get("", response_model=AppSettingsResponse)
async def get_app_settings(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AppSettingsResponse:
    row = await _load_settings(db)
    return _to_response(row)


@router.patch("", response_model=AppSettingsResponse)
async def update_app_settings(
    payload: AppSettingsUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AppSettingsResponse:
    row = await _load_settings(db)
    fields = payload.model_fields_set

    # Build a diff for the audit log alongside the in-place mutations
    # so admins can see *what* changed, not just that something did.
    # SMTP password value is excluded from the audit detail by ``redact``.
    diff: dict[str, object] = {}

    if "mfa_required" in fields and payload.mfa_required is not None:
        if row.mfa_required != payload.mfa_required:
            diff["mfa_required"] = payload.mfa_required
        row.mfa_required = payload.mfa_required

    if "smtp_host" in fields:
        if row.smtp_host != payload.smtp_host:
            diff["smtp_host"] = payload.smtp_host
        row.smtp_host = payload.smtp_host

    if "smtp_port" in fields:
        if row.smtp_port != payload.smtp_port:
            diff["smtp_port"] = payload.smtp_port
        row.smtp_port = payload.smtp_port

    if "smtp_username" in fields:
        if row.smtp_username != payload.smtp_username:
            diff["smtp_username"] = payload.smtp_username
        row.smtp_username = payload.smtp_username

    if "smtp_password" in fields:
        # Three valid intents:
        #   None        → no change (omitted)         — but pydantic
        #                  sets fields by name, so None *was* sent and
        #                  we treat it as an explicit clear too — ergo:
        #   None / ""   → clear stored password
        #   non-empty   → encrypt + store
        if payload.smtp_password is None or payload.smtp_password == "":
            if row.smtp_password_encrypted is not None:
                diff["smtp_password"] = "<cleared>"
            row.smtp_password_encrypted = None
        else:
            row.smtp_password_encrypted = encrypt_secret(payload.smtp_password)
            diff["smtp_password"] = "<set>"

    if "smtp_use_tls" in fields and payload.smtp_use_tls is not None:
        if row.smtp_use_tls != payload.smtp_use_tls:
            diff["smtp_use_tls"] = payload.smtp_use_tls
        row.smtp_use_tls = payload.smtp_use_tls

    if "smtp_from_address" in fields:
        new_val = (
            str(payload.smtp_from_address) if payload.smtp_from_address else None
        )
        if row.smtp_from_address != new_val:
            diff["smtp_from_address"] = new_val
        row.smtp_from_address = new_val

    if "smtp_from_name" in fields:
        if row.smtp_from_name != payload.smtp_from_name:
            diff["smtp_from_name"] = payload.smtp_from_name
        row.smtp_from_name = payload.smtp_from_name

    # ----- Phase 3 quota defaults -----
    # Same tri-state as everywhere else: omitted = unchanged, explicit
    # null = revert to "no default" (uncapped), int = new default.
    for field_name in (
        "default_storage_cap_bytes",
        "default_daily_token_budget",
        "default_monthly_token_budget",
    ):
        if field_name in fields:
            new_val = getattr(payload, field_name)
            if getattr(row, field_name) != new_val:
                diff[field_name] = new_val
            setattr(row, field_name, new_val)

    if diff:
        await record_event(
            db,
            request=request,
            event_type=EVENT_APP_SETTINGS_CHANGED,
            user_id=actor.id,
            identifier=actor.username,
            # smtp_password is already redacted to "<set>" / "<cleared>"
            # before reaching here, but pass the field through ``redact``
            # too as defence-in-depth in case someone refactors.
            detail=safe_dict(diff, redact=("smtp_password",)),
        )
    await db.commit()
    await db.refresh(row)
    return _to_response(row)

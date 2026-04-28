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

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from pydantic import BaseModel

from app.admin.schemas import AppSettingsResponse, AppSettingsUpdate
from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict
from app.auth.deps import require_admin
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.config import get_settings
from app.cors_dynamic import invalidate_cache as invalidate_cors_cache
from app.database import get_db

router = APIRouter()


def _normalise_origin(raw: str) -> str:
    """Validate & canonicalise a single CORS origin string.

    Accepts ``scheme://host[:port]`` (no path, no trailing slash). The
    set of allowed schemes is intentionally narrow because anything
    else either makes no sense as an Origin header value (``file:``,
    ``mailto:``) or is a footgun (``javascript:``).

    Raises ``HTTPException(400)`` with a precise message so a bad
    paste in the wizard surfaces inline rather than silently breaking
    CORS at runtime.
    """
    value = (raw or "").strip()
    if not value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Public origin cannot be blank.",
        )
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public origin must start with http:// or https:// (got '{value}').",
        )
    if not parsed.hostname:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public origin '{value}' is missing a hostname.",
        )
    if parsed.path and parsed.path != "/":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Public origin '{value}' must be just scheme://host[:port] "
                "with no path."
            ),
        )
    if parsed.query or parsed.fragment:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Public origin '{value}' must not contain query or fragment.",
        )
    # Canonical form: lowercase scheme + host, drop default port,
    # drop trailing slash.
    host = parsed.hostname.lower()
    port = parsed.port
    if port is None or (parsed.scheme == "http" and port == 80) or (
        parsed.scheme == "https" and port == 443
    ):
        netloc = host
    else:
        netloc = f"{host}:{port}"
    return f"{parsed.scheme}://{netloc}"


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
        public_origins=list(row.public_origins or []),
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

    # ----- Public CORS origins -----
    # Validated and de-duplicated; cache flushed below so the next
    # request from the new origin succeeds without waiting for the
    # CORS TTL to expire.
    cors_changed = False
    if "public_origins" in fields and payload.public_origins is not None:
        normalised: list[str] = []
        seen: set[str] = set()
        for raw in payload.public_origins:
            origin = _normalise_origin(raw)
            if origin in seen:
                continue
            seen.add(origin)
            normalised.append(origin)
        if list(row.public_origins or []) != normalised:
            diff["public_origins"] = normalised
            row.public_origins = normalised
            cors_changed = True

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
    if cors_changed:
        # The dynamic CORS middleware caches the resolved origin set
        # for ~15 s; flush it so the just-saved origin starts working
        # on the very next request rather than after the cache expires.
        invalidate_cors_cache()
    return _to_response(row)


# --------------------------------------------------------------------
# Wizard helpers
# --------------------------------------------------------------------
class OriginPreviewRequest(BaseModel):
    """Tiny payload used by the wizard's "Public URL" step.

    The frontend POSTs the URL the operator typed and gets back a
    canonicalised version plus any non-fatal warnings (e.g. plain HTTP
    on a non-localhost origin) so it can render the warning *before*
    the operator commits the save. Doing the check here rather than
    in the frontend keeps the rules in a single place — the same
    helper is used by the PATCH path so a later admin edit is held
    to the same standard.
    """

    public_origin: str


class OriginPreviewResponse(BaseModel):
    canonical: str
    warnings: list[str]


@router.post("/preview-origin", response_model=OriginPreviewResponse)
async def preview_origin(
    payload: OriginPreviewRequest,
    _: User = Depends(require_admin),
) -> OriginPreviewResponse:
    """Validate + canonicalise a candidate public origin without persisting.

    Used by the wizard so the operator can see the canonical form (e.g.
    ``HTTPS://Example.com:443`` becomes ``https://example.com``) and
    any HTTPS / cookie warnings before clicking "Save". Fully read-only
    — saving still happens via the normal PATCH path.
    """
    canonical = _normalise_origin(payload.public_origin)
    warnings = get_settings().validate_wizard_safety(public_origin=canonical)
    return OriginPreviewResponse(canonical=canonical, warnings=warnings)

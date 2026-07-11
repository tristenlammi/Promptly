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

import re
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

import httpx
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
        oidc_enabled=row.oidc_enabled,
        oidc_issuer=row.oidc_issuer,
        oidc_client_id=row.oidc_client_id,
        oidc_button_label=row.oidc_button_label,
        oidc_scopes=row.oidc_scopes,
        oidc_client_secret_set=bool(row.oidc_client_secret_encrypted),
        oidc_configured=bool(
            row.oidc_enabled
            and row.oidc_issuer
            and row.oidc_client_id
            and row.oidc_client_secret_encrypted
        ),
        default_storage_cap_bytes=row.default_storage_cap_bytes,
        default_daily_token_budget=row.default_daily_token_budget,
        default_monthly_token_budget=row.default_monthly_token_budget,
        public_origins=list(row.public_origins or []),
        chat_max_web_searches_per_turn=row.chat_max_web_searches_per_turn,
        vision_relay_provider_id=row.vision_relay_provider_id,
        vision_relay_model_id=row.vision_relay_model_id,
        vision_relay_configured=row.vision_relay_configured,
        default_chat_provider_id=row.default_chat_provider_id,
        default_chat_model_id=row.default_chat_model_id,
        default_chat_configured=row.default_chat_configured,
        research_provider_id=row.research_provider_id,
        research_model_id=row.research_model_id,
        research_configured=row.research_configured,
        study_provider_id=row.study_provider_id,
        study_model_id=row.study_model_id,
        study_configured=row.study_configured,
        study_assessor_provider_id=row.study_assessor_provider_id,
        study_assessor_model_id=row.study_assessor_model_id,
        study_assessor_configured=row.study_assessor_configured,
        memory_provider_id=row.memory_provider_id,
        memory_model_id=row.memory_model_id,
        memory_configured=row.memory_configured,
        image_gen_provider_id=row.image_gen_provider_id,
        image_gen_model_id=row.image_gen_model_id,
        image_gen_configured=row.image_gen_configured,
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

    # ----- SSO (OIDC) -----
    if "oidc_enabled" in fields and payload.oidc_enabled is not None:
        if row.oidc_enabled != payload.oidc_enabled:
            diff["oidc_enabled"] = payload.oidc_enabled
        row.oidc_enabled = payload.oidc_enabled

    for field_name in ("oidc_issuer", "oidc_client_id", "oidc_button_label", "oidc_scopes"):
        if field_name in fields:
            new_val = getattr(payload, field_name)
            # Normalise empty strings to NULL so "cleared" reads cleanly.
            if isinstance(new_val, str) and new_val.strip() == "":
                new_val = None
            if getattr(row, field_name) != new_val:
                diff[field_name] = new_val
            setattr(row, field_name, new_val)

    if "oidc_client_secret" in fields:
        # Same tri-state as smtp_password: None/"" clears, non-empty encrypts.
        if payload.oidc_client_secret is None or payload.oidc_client_secret == "":
            if row.oidc_client_secret_encrypted is not None:
                diff["oidc_client_secret"] = "<cleared>"
            row.oidc_client_secret_encrypted = None
        else:
            row.oidc_client_secret_encrypted = encrypt_secret(
                payload.oidc_client_secret
            )
            diff["oidc_client_secret"] = "<set>"

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

    # ----- Chat tool limits -----
    # Integer scalar — same tri-state convention as the other ints:
    # omitted = unchanged. Pydantic already enforced the 1..20 range
    # on the way in, so the router just persists.
    if (
        "chat_max_web_searches_per_turn" in fields
        and payload.chat_max_web_searches_per_turn is not None
    ):
        new_val = payload.chat_max_web_searches_per_turn
        if row.chat_max_web_searches_per_turn != new_val:
            diff["chat_max_web_searches_per_turn"] = new_val
        row.chat_max_web_searches_per_turn = new_val

    # ----- Vision relay -----
    # Two halves move as a unit. The pydantic schema treats both as
    # individually optional, but at runtime they only make sense
    # together: a provider id without a model id is half-configured
    # and would just silently no-op at chat time. We force the admin
    # to send both, with explicit ``null`` for both meaning "disable",
    # rather than letting a sloppy PATCH leave the row in a confusing
    # state.
    pid_set = "vision_relay_provider_id" in fields
    mid_set = "vision_relay_model_id" in fields
    if pid_set != mid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "vision_relay_provider_id and vision_relay_model_id must "
                "be sent together — pass both to enable the relay, or "
                "both as null to disable it."
            ),
        )
    if pid_set and mid_set:
        new_pid = payload.vision_relay_provider_id
        new_mid = payload.vision_relay_model_id
        # Disallow only one half being null (the schema permits it
        # individually, but the combo is meaningless).
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "vision_relay_provider_id and vision_relay_model_id "
                    "must both be set or both be null."
                ),
            )
        if row.vision_relay_provider_id != new_pid:
            diff["vision_relay_provider_id"] = (
                str(new_pid) if new_pid else None
            )
        if row.vision_relay_model_id != new_mid:
            diff["vision_relay_model_id"] = new_mid
        row.vision_relay_provider_id = new_pid
        row.vision_relay_model_id = new_mid

    # ----- Default chat model -----
    # Same paired semantics as the vision-relay block above. Repeating
    # the validation rather than abstracting it keeps the two settings
    # independently maintainable — neither is so complex that a shared
    # helper would actually pay off, and the explicit copy makes diffs
    # for either field grep-friendly.
    dpid_set = "default_chat_provider_id" in fields
    dmid_set = "default_chat_model_id" in fields
    if dpid_set != dmid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "default_chat_provider_id and default_chat_model_id must "
                "be sent together — pass both to set a default, or both "
                "as null to clear."
            ),
        )
    if dpid_set and dmid_set:
        new_pid = payload.default_chat_provider_id
        new_mid = payload.default_chat_model_id
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "default_chat_provider_id and default_chat_model_id "
                    "must both be set or both be null."
                ),
            )
        if row.default_chat_provider_id != new_pid:
            diff["default_chat_provider_id"] = (
                str(new_pid) if new_pid else None
            )
        if row.default_chat_model_id != new_mid:
            diff["default_chat_model_id"] = new_mid
        row.default_chat_provider_id = new_pid
        row.default_chat_model_id = new_mid

    # ----- Deep Research model -----
    rpid_set = "research_provider_id" in fields
    rmid_set = "research_model_id" in fields
    if rpid_set != rmid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "research_provider_id and research_model_id must be sent "
                "together — pass both to set a research model, or both as "
                "null to clear."
            ),
        )
    if rpid_set and rmid_set:
        new_pid = payload.research_provider_id
        new_mid = payload.research_model_id
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "research_provider_id and research_model_id must both "
                    "be set or both be null."
                ),
            )
        if row.research_provider_id != new_pid:
            diff["research_provider_id"] = str(new_pid) if new_pid else None
        if row.research_model_id != new_mid:
            diff["research_model_id"] = new_mid
        row.research_provider_id = new_pid
        row.research_model_id = new_mid

    # ----- Study / Teaching model -----
    spid_set = "study_provider_id" in fields
    smid_set = "study_model_id" in fields
    if spid_set != smid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "study_provider_id and study_model_id must be sent together — "
                "pass both to set a study teaching model, or both as null to clear."
            ),
        )
    if spid_set and smid_set:
        new_pid = payload.study_provider_id
        new_mid = payload.study_model_id
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="study_provider_id and study_model_id must both be set or both be null.",
            )
        if row.study_provider_id != new_pid:
            diff["study_provider_id"] = str(new_pid) if new_pid else None
        if row.study_model_id != new_mid:
            diff["study_model_id"] = new_mid
        row.study_provider_id = new_pid
        row.study_model_id = new_mid

    # ----- Study / Assessor model -----
    sapid_set = "study_assessor_provider_id" in fields
    samid_set = "study_assessor_model_id" in fields
    if sapid_set != samid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "study_assessor_provider_id and study_assessor_model_id must be sent "
                "together — pass both to set an assessor model, or both as null to clear."
            ),
        )
    if sapid_set and samid_set:
        new_pid = payload.study_assessor_provider_id
        new_mid = payload.study_assessor_model_id
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "study_assessor_provider_id and study_assessor_model_id must "
                    "both be set or both be null."
                ),
            )
        if row.study_assessor_provider_id != new_pid:
            diff["study_assessor_provider_id"] = str(new_pid) if new_pid else None
        if row.study_assessor_model_id != new_mid:
            diff["study_assessor_model_id"] = new_mid
        row.study_assessor_provider_id = new_pid
        row.study_assessor_model_id = new_mid

    # ----- Memory extraction model -----
    mpid_set = "memory_provider_id" in fields
    mmid_set = "memory_model_id" in fields
    if mpid_set != mmid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "memory_provider_id and memory_model_id must be sent together — "
                "pass both to set a memory model, or both as null to clear."
            ),
        )
    if mpid_set and mmid_set:
        new_pid = payload.memory_provider_id
        new_mid = payload.memory_model_id
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "memory_provider_id and memory_model_id must both be set "
                    "or both be null."
                ),
            )
        if row.memory_provider_id != new_pid:
            diff["memory_provider_id"] = str(new_pid) if new_pid else None
        if row.memory_model_id != new_mid:
            diff["memory_model_id"] = new_mid
        row.memory_provider_id = new_pid
        row.memory_model_id = new_mid

    # ----- Image generation model -----
    igpid_set = "image_gen_provider_id" in fields
    igmid_set = "image_gen_model_id" in fields
    if igpid_set != igmid_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "image_gen_provider_id and image_gen_model_id must be sent "
                "together — pass both to set the image model, or both as "
                "null to clear."
            ),
        )
    if igpid_set and igmid_set:
        new_pid = payload.image_gen_provider_id
        new_mid = payload.image_gen_model_id
        if (new_pid is None) != (new_mid is None):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "image_gen_provider_id and image_gen_model_id must both "
                    "be set or both be null."
                ),
            )
        if row.image_gen_provider_id != new_pid:
            diff["image_gen_provider_id"] = str(new_pid) if new_pid else None
        if row.image_gen_model_id != new_mid:
            diff["image_gen_model_id"] = new_mid
        row.image_gen_provider_id = new_pid
        row.image_gen_model_id = new_mid

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
            detail=safe_dict(diff, redact=("smtp_password", "oidc_client_secret")),
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


# --------------------------------------------------------------------
# Email autoconfig (Thunderbird-style "type your address, servers fill in")
# --------------------------------------------------------------------
# We look the domain up in Mozilla's public ISPDB — the same database
# Thunderbird uses — which returns the SMTP host/port/security for Gmail,
# Outlook, Yahoo, iCloud, Fastmail and thousands of ISPs. It only gives
# *server settings*, never credentials, so the operator still enters their
# username + password (an App Password for Gmail). Best-effort: if the
# lookup fails (no ISPDB entry, or this box has no outbound internet), the
# wizard just falls back to manual entry.
_ISPDB_URL = "https://autoconfig.thunderbird.net/v1.1/{domain}"
_DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$")


class AutoconfigResponse(BaseModel):
    found: bool
    provider: str | None = None
    host: str | None = None
    port: int | None = None
    # ``True`` for both SSL (implicit, port 465) and STARTTLS (587); the
    # sender picks the exact mode by port. ``False`` only for plain relays.
    use_tls: bool | None = None
    username: str | None = None
    # Set when the provider is known to require an app-specific password
    # (e.g. Gmail with 2FA) rather than the plain account password.
    note: str | None = None


@router.get("/email-autoconfig", response_model=AutoconfigResponse)
async def email_autoconfig(
    email: str,
    _: User = Depends(require_admin),
) -> AutoconfigResponse:
    """Best-effort SMTP settings for an email address, via Mozilla's ISPDB."""
    domain = email.rsplit("@", 1)[-1].strip().lower()
    # Guard the path segment: only a bare hostname ever reaches the URL, so a
    # crafted "email" can't redirect the fetch anywhere but thunderbird.net.
    if "@" not in email or not _DOMAIN_RE.match(domain):
        return AutoconfigResponse(found=False)

    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            resp = await client.get(_ISPDB_URL.format(domain=domain))
        if resp.status_code != 200 or not resp.content:
            return AutoconfigResponse(found=False)
        # ISPDB is a fixed, trusted host serving small XML with no DTD; parse
        # with the stdlib but cap the body so a surprise huge response can't
        # blow up memory.
        root = ET.fromstring(resp.content[: 256 * 1024])
    except (httpx.HTTPError, ET.ParseError, ValueError):
        return AutoconfigResponse(found=False)

    smtp = root.find(".//outgoingServer[@type='smtp']")
    if smtp is None:
        return AutoconfigResponse(found=False)

    def _text(tag: str) -> str | None:
        el = smtp.find(tag)
        return el.text.strip() if el is not None and el.text else None

    host = _text("hostname")
    port_raw = _text("port")
    socket_type = (_text("socketType") or "").upper()
    if not host or not port_raw:
        return AutoconfigResponse(found=False)
    try:
        port = int(port_raw)
    except ValueError:
        return AutoconfigResponse(found=False)

    # SSL / STARTTLS → encrypted; the sender picks implicit-vs-STARTTLS by
    # port. Only an explicit "plain" means no encryption.
    use_tls = socket_type != "PLAIN"

    # Resolve the ISPDB username template against the real address.
    localpart, _, _dom = email.partition("@")
    username = _text("username") or "%EMAILADDRESS%"
    username = (
        username.replace("%EMAILADDRESS%", email)
        .replace("%EMAILLOCALPART%", localpart)
        .replace("%EMAILDOMAIN%", domain)
    )

    provider = None
    prov_el = root.find(".//displayName")
    if prov_el is not None and prov_el.text:
        provider = prov_el.text.strip()

    note = None
    if domain in {"gmail.com", "googlemail.com"}:
        note = (
            "Gmail needs an App Password (turn on 2-Step Verification, then "
            "create one) — your normal password won't work for SMTP."
        )

    return AutoconfigResponse(
        found=True,
        provider=provider,
        host=host,
        port=port,
        use_tls=use_tls,
        username=username,
        note=note,
    )


@router.post("/test-email")
async def send_test_email(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> dict[str, bool]:
    """Send a test email to the admin's own address to validate SMTP config."""
    # Imported lazily to avoid pulling the SMTP stack into the module import
    # graph before it's needed.
    from app.mfa.smtp import (
        SmtpNotConfiguredError,
        SmtpSendError,
        send_message,
    )

    try:
        await send_message(
            db,
            to=actor.email,
            subject="Promptly SMTP test",
            text_body=(
                "This is a test email from your Promptly install.\n\n"
                "If you're reading this, outgoing email is working — "
                "sign-in codes, notifications, automations, and feedback "
                "will all be able to send.\n\n— Promptly\n"
            ),
        )
    except SmtpNotConfiguredError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="SMTP isn't configured yet — save your settings first.",
        ) from e
    except SmtpSendError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Couldn't send the test email. Double-check the host, port, "
                "username and password (Gmail needs an App Password)."
            ),
        ) from e
    return {"sent": True}

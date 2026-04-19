"""Auth router — register / login / refresh / logout / me.

Refresh tokens are delivered as an HttpOnly cookie and never exposed to JS.
The access token is returned in the response body for the frontend to hold
in memory (Zustand). This mirrors Claude.ai's flow and the spec in §12.

Phase 1 hardening (2026-04-19):

* Failed-login lockout via ``User.failed_login_attempts`` /
  ``LOCKOUT_THRESHOLD``. Lockout is permanent until an admin unlocks.
* Constant-time username enumeration defense via
  ``waste_a_verify`` on the user-not-found branch.
* Token revocation: every JWT now carries a ``tv`` claim. Bumping
  ``User.token_version`` invalidates outstanding sessions immediately.
* Audit log: every login attempt, lockout, refresh rejection, and
  logout writes a row to ``auth_events``.
* Last-login telemetry recorded on every successful authentication.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import (
    EVENT_LOGIN_FAIL,
    EVENT_LOGIN_SUCCESS,
    EVENT_LOCKOUT,
    EVENT_LOGOUT,
    EVENT_REFRESH_REJECTED,
    EVENT_TOKEN_REFRESH,
    record_event,
    request_meta,
)
from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.schemas import (
    AuthResponse,
    LoginRequest,
    RegisterRequest,
    SetupRequest,
    SetupStatusResponse,
    TokenResponse,
    UserPreferencesUpdate,
    UserResponse,
)
from app.auth.utils import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    TokenError,
    create_access_token,
    create_mfa_challenge_token,
    create_mfa_enrollment_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
    waste_a_verify,
)
from app.config import get_settings
from app.database import get_db
from app.files.system_folders import seed_system_folders
from app.mfa import service as mfa_service
from app.mfa import trusted as trusted_devices
from app.mfa.email_otp import (
    EmailOtpRateLimited,
    issue_and_send as issue_and_send_email_otp,
)
from app.mfa.models import METHOD_EMAIL, OTP_PURPOSE_LOGIN
from app.mfa.service import MfaOutcome
from app.mfa.smtp import SmtpNotConfiguredError, SmtpSendError
from app.rate_limit import (
    RateLimitLogin,
    RateLimitRefresh,
    RateLimitSetup,
    enforce_login_identifier_rate,
)

router = APIRouter()
settings = get_settings()

REFRESH_COOKIE_NAME = "promptly_refresh"
ACCESS_TOKEN_EXPIRE_SECONDS = ACCESS_TOKEN_EXPIRE_MINUTES * 60
REFRESH_TOKEN_EXPIRE_SECONDS = REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60

# Single canonical error message returned by the login endpoint for
# *every* failure mode (wrong password, unknown user, locked account,
# disabled account). Never leaks why authentication failed — that's
# information an attacker can use.
GENERIC_AUTH_FAIL_DETAIL = "Invalid credentials"


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Issue / refresh the HttpOnly refresh-token cookie.

    Cookie attributes are driven by ``COOKIE_SECURE`` / ``COOKIE_SAMESITE``
    in ``Settings``; defaults are production-safe (Secure + SameSite=strict).
    """
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=REFRESH_TOKEN_EXPIRE_SECONDS,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        path="/api/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=REFRESH_COOKIE_NAME, path="/api/auth")


def _issue_tokens_for(user: User, response: Response) -> AuthResponse:
    access = create_access_token(user.id, token_version=user.token_version)
    refresh = create_refresh_token(user.id, token_version=user.token_version)
    _set_refresh_cookie(response, refresh)
    return AuthResponse(
        status="ok",
        user=UserResponse.model_validate(user),
        access_token=access,
        expires_in=ACCESS_TOKEN_EXPIRE_SECONDS,
    )


# Short-lived JWT TTLs for the two MFA-related token types. Long enough
# for a human to find their authenticator app or open their inbox; short
# enough that a leaked token isn't a viable attack vector.
def _mfa_challenge_ttl():
    from datetime import timedelta as _td
    return _td(minutes=settings.MFA_CHALLENGE_TOKEN_TTL_MINUTES)


def _issue_mfa_challenge(
    user: User,
    *,
    method: str,
    email_hint: str | None,
) -> AuthResponse:
    ttl = _mfa_challenge_ttl()
    token = create_mfa_challenge_token(
        user.id,
        token_version=user.token_version,
        expires_delta=ttl,
    )
    return AuthResponse(
        status="mfa_required",
        challenge_token=token,
        expires_in=int(ttl.total_seconds()),
        method=method,  # type: ignore[arg-type]
        email_hint=email_hint,
    )


def _issue_mfa_enrollment(user: User) -> AuthResponse:
    ttl = _mfa_challenge_ttl()
    token = create_mfa_enrollment_token(
        user.id,
        token_version=user.token_version,
        expires_delta=ttl,
    )
    return AuthResponse(
        status="mfa_enrollment_required",
        enrollment_token=token,
        expires_in=int(ttl.total_seconds()),
    )


async def _admin_exists(db: AsyncSession) -> bool:
    count = await db.scalar(
        select(func.count()).select_from(User).where(User.role == "admin")
    )
    return bool(count)


# --------------------------------------------------------------------
# First-run setup
# --------------------------------------------------------------------
@router.get("/setup-status", response_model=SetupStatusResponse)
async def setup_status(db: AsyncSession = Depends(get_db)) -> SetupStatusResponse:
    """Cheap public probe used by the frontend on boot.

    Returns ``requires_setup=true`` when the DB has no admin yet — the only
    way out of that state is POST /api/auth/setup.
    """
    if settings.SINGLE_USER_MODE:
        # Legacy mode provisions its own admin unconditionally.
        return SetupStatusResponse(requires_setup=False)
    return SetupStatusResponse(requires_setup=not await _admin_exists(db))


@router.post("/setup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def setup(
    payload: SetupRequest,
    request: Request,
    response: Response,
    _rl: RateLimitSetup,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Create the very first admin account.

    Idempotently guarded: if an admin already exists the request is rejected
    with 409 so we can't be used to escalate privilege after the fact.
    """
    if settings.SINGLE_USER_MODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Setup is not available in single-user mode",
        )
    if await _admin_exists(db):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Setup has already been completed",
        )

    user = User(
        email=payload.email.lower(),
        username=payload.username,
        password_hash=hash_password(payload.password),
        role="admin",
        allowed_models=None,
        settings={},
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username already registered",
        )
    await db.refresh(user)

    # Audit + last-login telemetry for the bootstrap admin so the log
    # is complete from row 1.
    ip, ua = request_meta(request)
    user.last_login_at = datetime.now(timezone.utc)
    user.last_login_ip = ip[:64] or None
    await record_event(
        db,
        request=request,
        event_type=EVENT_LOGIN_SUCCESS,
        user_id=user.id,
        identifier=user.username,
        detail="initial setup",
    )
    # Materialise the per-user system folders (Chat Uploads / Generated
    # Files) so the brand-new admin's Files page is populated from the
    # very first visit instead of waiting on a chat upload to lazily
    # create them.
    await seed_system_folders(db, user)
    await db.commit()
    await db.refresh(user)
    return _issue_tokens_for(user, response)


# --------------------------------------------------------------------
# Register (disabled — admins create users via /api/admin/users)
# --------------------------------------------------------------------
@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterRequest,  # noqa: ARG001 — kept for OpenAPI compatibility
    response: Response,  # noqa: ARG001
    db: AsyncSession = Depends(get_db),  # noqa: ARG001
) -> AuthResponse:
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Public registration is disabled. Ask an admin to create an account.",
    )


# --------------------------------------------------------------------
# Login
# --------------------------------------------------------------------
async def _record_login_failure(
    db: AsyncSession,
    request: Request,
    *,
    user: User | None,
    identifier: str,
    reason: str,
) -> None:
    """Helper used on every login-failure path.

    Bumps the failed-attempt counter (and locks if threshold reached)
    when a real user row exists, then writes the audit row. Caller is
    responsible for committing.
    """
    if user is not None:
        user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
        if (
            user.locked_at is None
            and user.failed_login_attempts >= settings.LOCKOUT_THRESHOLD
        ):
            user.locked_at = datetime.now(timezone.utc)
            await record_event(
                db,
                request=request,
                event_type=EVENT_LOCKOUT,
                user_id=user.id,
                identifier=identifier,
                detail=(
                    f"automatic after {user.failed_login_attempts} "
                    "consecutive failures"
                ),
            )

    await record_event(
        db,
        request=request,
        event_type=EVENT_LOGIN_FAIL,
        user_id=user.id if user is not None else None,
        identifier=identifier,
        detail=reason,
    )


@router.post("/login", response_model=AuthResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    _rl: RateLimitLogin,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    if settings.SINGLE_USER_MODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Login is not required in single-user mode",
        )

    if not await _admin_exists(db):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Promptly hasn't been set up yet. Visit /setup to create the first admin.",
        )

    ident = payload.identifier.strip()
    # Per-identifier throttle (defends against credential spray that
    # rotates IPs but keeps hammering one account). Runs before the DB
    # lookup so a tripped limit costs zero query cycles.
    await enforce_login_identifier_rate(request, ident)

    result = await db.execute(
        select(User).where(or_(User.email == ident.lower(), User.username == ident))
    )
    user = result.scalar_one_or_none()

    # ----------------------------------------------------------------
    # Branch: no such user.
    #
    # Run a dummy bcrypt verify so timing matches the "user found,
    # wrong password" path. Audit the attempt with no user_id so admins
    # can spot enumeration attacks. Always raise the generic error.
    # ----------------------------------------------------------------
    if user is None:
        waste_a_verify()
        await _record_login_failure(
            db,
            request,
            user=None,
            identifier=ident,
            reason="unknown_identifier",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_AUTH_FAIL_DETAIL,
        )

    # ----------------------------------------------------------------
    # Branch: user exists but is locked / disabled.
    #
    # We *still* run verify_password against the real hash before
    # rejecting, otherwise an attacker could distinguish locked accounts
    # by response timing. The audit log captures the real reason.
    # ----------------------------------------------------------------
    password_ok = verify_password(payload.password, user.password_hash)

    if user.disabled:
        await _record_login_failure(
            db,
            request,
            user=user,
            identifier=ident,
            reason="account_disabled",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_AUTH_FAIL_DETAIL,
        )

    if user.locked_at is not None:
        await _record_login_failure(
            db,
            request,
            user=user,
            identifier=ident,
            reason="account_locked",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_AUTH_FAIL_DETAIL,
        )

    if not password_ok:
        await _record_login_failure(
            db,
            request,
            user=user,
            identifier=ident,
            reason="wrong_password",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_AUTH_FAIL_DETAIL,
        )

    # ----------------------------------------------------------------
    # Password OK.
    # ----------------------------------------------------------------
    user.failed_login_attempts = 0
    ip, _ = request_meta(request)

    # Decide whether MFA gates this session. ``mfa_decision_for``
    # consults the user's enrollment + the trusted-device cookie + the
    # global ``mfa_required`` switch in one call.
    trust_token = trusted_devices.cookie_token(request)
    decision = await mfa_service.mfa_decision_for(
        db, user=user, trusted_token=trust_token
    )

    # ---- Branch A: MFA challenge (user is enrolled, no trusted device).
    if decision.outcome is MfaOutcome.CHALLENGE:
        # If the enrolled method is "email", proactively send the OTP
        # so the user doesn't need an extra round-trip after login. We
        # *don't* fail the login if SMTP send fails — the frontend can
        # always re-trigger via /auth/mfa/email/send, which surfaces a
        # better error to the user.
        if decision.challenge_method == METHOD_EMAIL and decision.challenge_email_to:
            try:
                await issue_and_send_email_otp(
                    db,
                    user_id=user.id,
                    to_address=decision.challenge_email_to,
                    purpose=OTP_PURPOSE_LOGIN,
                    request=request,
                )
            except (EmailOtpRateLimited, SmtpNotConfiguredError, SmtpSendError):
                # Best effort. The challenge is still issued; the user
                # can retry the send from the verify screen.
                pass
        await record_event(
            db,
            request=request,
            event_type=EVENT_LOGIN_SUCCESS,
            user_id=user.id,
            identifier=ident,
            detail="awaiting_mfa",
        )
        await db.commit()
        return _issue_mfa_challenge(
            user,
            method=decision.challenge_method or "totp",
            email_hint=(
                mfa_service.mask_email(decision.challenge_email_to)
                if decision.challenge_email_to
                else None
            ),
        )

    # ---- Branch B: forced enrollment (mfa_required + no method yet).
    if decision.outcome is MfaOutcome.ENROLLMENT_REQUIRED:
        await record_event(
            db,
            request=request,
            event_type=EVENT_LOGIN_SUCCESS,
            user_id=user.id,
            identifier=ident,
            detail="awaiting_enrollment",
        )
        await db.commit()
        return _issue_mfa_enrollment(user)

    # ---- Branch C: real session (no MFA, or trusted device matched).
    user.last_login_at = datetime.now(timezone.utc)
    user.last_login_ip = ip[:64] or None
    await record_event(
        db,
        request=request,
        event_type=EVENT_LOGIN_SUCCESS,
        user_id=user.id,
        identifier=ident,
    )
    await db.commit()
    await db.refresh(user)
    return _issue_tokens_for(user, response)


# --------------------------------------------------------------------
# Refresh
# --------------------------------------------------------------------
@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    response: Response,
    _rl: RateLimitRefresh,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    if settings.SINGLE_USER_MODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Refresh is not required in single-user mode",
        )

    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing refresh token",
        )

    try:
        payload = decode_token(token, expected_type="refresh")
        user_id = uuid.UUID(payload["sub"])
        token_tv = int(payload.get("tv", 0))
    except (TokenError, ValueError, KeyError) as e:
        _clear_refresh_cookie(response)
        await record_event(
            db,
            request=request,
            event_type=EVENT_REFRESH_REJECTED,
            detail=f"decode_failed: {e}",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid refresh token: {e}",
        )

    user = await db.get(User, user_id)
    if user is None:
        _clear_refresh_cookie(response)
        await record_event(
            db,
            request=request,
            event_type=EVENT_REFRESH_REJECTED,
            detail="user_missing",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists",
        )

    # Mirror the same revocation rules ``get_current_user`` enforces so a
    # locked / disabled / token-versioned-out user can't quietly mint
    # fresh access tokens.
    if (
        user.disabled
        or user.locked_at is not None
        or token_tv != user.token_version
    ):
        _clear_refresh_cookie(response)
        await record_event(
            db,
            request=request,
            event_type=EVENT_REFRESH_REJECTED,
            user_id=user.id,
            detail=(
                "disabled"
                if user.disabled
                else "locked"
                if user.locked_at is not None
                else "token_version_mismatch"
            ),
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is no longer valid",
        )

    new_refresh = create_refresh_token(user.id, token_version=user.token_version)
    _set_refresh_cookie(response, new_refresh)
    await record_event(
        db,
        request=request,
        event_type=EVENT_TOKEN_REFRESH,
        user_id=user.id,
    )
    await db.commit()
    return TokenResponse(
        access_token=create_access_token(user.id, token_version=user.token_version),
        expires_in=ACCESS_TOKEN_EXPIRE_SECONDS,
    )


# --------------------------------------------------------------------
# Logout
# --------------------------------------------------------------------
@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> Response:
    # Best-effort audit: if the refresh cookie is still valid we know
    # which user we just logged out. Failures here must never block the
    # logout itself.
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    user_id: uuid.UUID | None = None
    if token:
        try:
            payload = decode_token(token, expected_type="refresh")
            user_id = uuid.UUID(payload["sub"])
        except (TokenError, ValueError, KeyError):
            user_id = None
    if user_id is not None:
        await record_event(
            db,
            request=request,
            event_type=EVENT_LOGOUT,
            user_id=user_id,
        )
        await db.commit()

    _clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# --------------------------------------------------------------------
# Me
# --------------------------------------------------------------------
@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse.model_validate(current_user)


@router.patch("/me/preferences", response_model=UserResponse)
async def update_preferences(
    payload: UserPreferencesUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Merge a small whitelisted set of keys into ``user.settings``.

    The frontend hits this when the user flips the in-chat Tools / Web
    toggles or the matching switches on the account preferences panel.
    Anything not listed in :class:`UserPreferencesUpdate` is rejected
    by Pydantic (``extra="forbid"``), so we don't have to police the
    payload here.
    """
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        return UserResponse.model_validate(current_user)

    # ``settings`` is JSONB — mutating the dict in place won't flag the
    # column as dirty under SQLAlchemy's default change-tracking. Build
    # a fresh dict and reassign so the UPDATE actually fires.
    merged = dict(current_user.settings or {})
    # Any string field whose value lands as ``""`` is a "clear this
    # preference" signal from the frontend (the panel renders a Reset
    # button that PATCHes ``location: ""`` rather than the field being
    # omitted, which would mean "no change"). Strip those keys out of
    # the merged dict instead of persisting an empty string into JSONB.
    for key, value in updates.items():
        if isinstance(value, str) and value == "":
            merged.pop(key, None)
        else:
            merged[key] = value
    current_user.settings = merged

    await db.commit()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)

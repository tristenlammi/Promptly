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

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import RedirectResponse
from jose import jwt as jose_jwt
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import (
    EVENT_LOGIN_FAIL,
    EVENT_LOGIN_SUCCESS,
    EVENT_LOCKOUT,
    EVENT_LOGOUT,
    EVENT_PASSWORD_CHANGE,
    EVENT_REFRESH_REJECTED,
    EVENT_TOKEN_REFRESH,
    EVENT_UNLOCK,
    record_event,
    request_meta,
)
from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.schemas import (
    AuthResponse,
    ChangePasswordRequest,
    DirectoryUser,
    LoginRequest,
    RegisterRequest,
    SetupRequest,
    SetupStatusResponse,
    SsoStatusResponse,
    TokenResponse,
    UserPreferencesUpdate,
    UserResponse,
)
from app.auth.oidc import (
    OidcError,
    build_authorize_url,
    exchange_and_verify,
    load_oidc_config,
    verified_email_from_claims,
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


# --------------------------------------------------------------------
# SSO (OIDC single sign-on) — optional, off by default. Authenticates
# INVITED users only: the IdP's verified email must match an existing,
# active account (no auto-provisioning). Local password login is
# unaffected whether or not SSO is configured.
# --------------------------------------------------------------------
_OIDC_TX_COOKIE = "promptly_oidc_tx"
_OIDC_TX_TTL_MINUTES = 10


def _safe_next(nxt: str | None) -> str:
    """Only allow same-origin relative paths as a post-login destination —
    never an absolute/scheme URL (open-redirect guard)."""
    if not nxt or not nxt.startswith("/") or nxt.startswith("//"):
        return "/"
    return nxt


def _oidc_redirect_uri(request: Request) -> str:
    """The callback URL, built from the public host/proto the browser used so
    it matches what's registered at the IdP. Computed identically in the login
    and callback routes so the two OIDC ``redirect_uri`` values agree."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
    )
    return f"{proto}://{host}".rstrip("/") + "/api/auth/oidc/callback"


def _sign_oidc_tx(state: str, nonce: str, next_path: str) -> str:
    payload = {
        "state": state,
        "nonce": nonce,
        "next": next_path,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=_OIDC_TX_TTL_MINUTES),
    }
    return jose_jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")


def _read_oidc_tx(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return jose_jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except Exception:  # noqa: BLE001 — expired/tampered tx → treat as absent
        return None


def _sso_fail(reason: str) -> RedirectResponse:
    """Bounce back to the login screen with a short error code the SPA turns
    into a friendly message. Clears the transaction cookie."""
    resp = RedirectResponse(f"/login?sso_error={quote(reason)}", status_code=302)
    resp.delete_cookie(_OIDC_TX_COOKIE, path="/api/auth")
    return resp


@router.get("/sso-status", response_model=SsoStatusResponse)
async def sso_status(db: AsyncSession = Depends(get_db)) -> SsoStatusResponse:
    """Public probe: is SSO enabled, and what should the button say?"""
    cfg = await load_oidc_config(db)
    if cfg is None:
        return SsoStatusResponse(enabled=False)
    return SsoStatusResponse(enabled=True, button_label=cfg.button_label)


@router.get("/oidc/login")
async def oidc_login(
    request: Request,
    next: str = "/",
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Kick off the OIDC flow: redirect the browser to the identity provider."""
    cfg = await load_oidc_config(db)
    if cfg is None:
        raise HTTPException(status_code=404, detail="SSO is not enabled.")
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    try:
        url = await build_authorize_url(
            cfg,
            redirect_uri=_oidc_redirect_uri(request),
            state=state,
            nonce=nonce,
        )
    except OidcError:
        return _sso_fail("provider_unreachable")
    resp = RedirectResponse(url, status_code=302)
    resp.set_cookie(
        key=_OIDC_TX_COOKIE,
        value=_sign_oidc_tx(state, nonce, _safe_next(next)),
        max_age=_OIDC_TX_TTL_MINUTES * 60,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        # Lax (not Strict) so the cookie survives the top-level redirect back
        # from the IdP; the callback needs it to check state/nonce.
        samesite="lax",
        path="/api/auth",
    )
    return resp


@router.get("/oidc/callback")
async def oidc_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Handle the IdP redirect: verify the id_token, match an invited user,
    log them in by setting the refresh cookie and bouncing into the app."""
    if error:
        return _sso_fail("provider_denied")
    tx = _read_oidc_tx(request.cookies.get(_OIDC_TX_COOKIE))
    if not tx or not code or not state or state != tx.get("state"):
        return _sso_fail("bad_state")

    cfg = await load_oidc_config(db)
    if cfg is None:
        return _sso_fail("sso_disabled")

    try:
        claims = await exchange_and_verify(
            cfg,
            code=code,
            redirect_uri=_oidc_redirect_uri(request),
            nonce=tx.get("nonce", ""),
        )
    except OidcError:
        return _sso_fail("verify_failed")

    email = verified_email_from_claims(claims)
    if not email:
        return _sso_fail("no_verified_email")

    user = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    # Invite-only: SSO logs in EXISTING, active accounts only. An unknown or
    # disabled email is refused — SSO never creates or re-enables an account.
    if user is None or user.disabled:
        return _sso_fail("no_account")

    user.last_login_at = datetime.now(timezone.utc)
    await record_event(
        db,
        request=request,
        event_type=EVENT_LOGIN_SUCCESS,
        user_id=user.id,
        identifier=email,
    )
    await db.commit()
    await db.refresh(user)

    # Set the refresh cookie on the redirect and bounce into the app; the SPA
    # exchanges it for an access token on load (same as a normal page refresh).
    redirect = RedirectResponse(_safe_next(tx.get("next")), status_code=302)
    _set_refresh_cookie(
        redirect,
        create_refresh_token(user.id, token_version=user.token_version),
    )
    redirect.delete_cookie(_OIDC_TX_COOKIE, path="/api/auth")
    return redirect


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
    # Serialise concurrent first-run setups. Without this, two requests racing
    # during the brief pre-provisioning window can BOTH pass the
    # "no admin yet" check before either commits and end up creating two
    # admins. A transaction-scoped advisory lock (auto-released on
    # commit/rollback) forces the second caller to wait, after which it sees
    # the admin the first created and 409s. The key is an arbitrary fixed
    # 64-bit constant shared by all setup callers.
    from sqlalchemy import text as _sa_text

    await db.execute(_sa_text("SELECT pg_advisory_xact_lock(918273645)"))
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

    # A brute-force lockout whose cooldown has elapsed is auto-cleared here
    # so the user (or anyone whose account was frozen by a malicious
    # five-attempt spray) recovers on their next attempt without an admin
    # round-trip. ``is_locked`` is the cooldown-aware predicate; a stale
    # ``locked_at`` with ``is_locked`` False means the window has passed.
    if user.locked_at is not None and not user.is_locked:
        user.locked_at = None
        user.failed_login_attempts = 0
        await record_event(
            db,
            request=request,
            event_type=EVENT_UNLOCK,
            user_id=user.id,
            identifier=ident,
            detail="auto after lockout cooldown",
        )

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

    if user.is_locked:
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
        # Don't echo the decode-exception text to the client — it can leak
        # library/decode detail. The real reason is already in the audit
        # row above; the client just gets a generic message.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
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
        or user.is_locked
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
                if user.is_locked
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


@router.post("/me/password", response_model=AuthResponse)
async def change_own_password(
    payload: ChangePasswordRequest,
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Self-service password change.

    Previously missing entirely: a user issued a temporary password (admin
    create / reset / CSV import) had no way to change it, and
    ``must_change_password`` was only an advisory UI nudge. This verifies the
    current password, applies the strength policy to the new one, bumps
    ``token_version`` (logging out every OTHER session), clears the
    force-change flag, and returns fresh tokens so THIS session stays live.
    """
    if not verify_password(payload.current_password, current_user.password_hash):
        # Generic 400 (no "user exists" signal needed — they're authenticated).
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect.",
        )
    if verify_password(payload.new_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from the current one.",
        )

    current_user.password_hash = hash_password(payload.new_password)
    # Invalidate every outstanding session (incl. a possible attacker's) —
    # ``_issue_tokens_for`` below re-issues this session against the new value.
    current_user.token_version = (current_user.token_version or 0) + 1
    if getattr(current_user, "must_change_password", False):
        current_user.must_change_password = False

    await record_event(
        db,
        request=request,
        event_type=EVENT_PASSWORD_CHANGE,
        user_id=current_user.id,
        identifier=current_user.username,
        detail="self-service change",
    )
    await db.commit()
    await db.refresh(current_user)
    return _issue_tokens_for(current_user, response)


@router.get("/users/directory", response_model=list[DirectoryUser])
async def list_directory_users(
    q: str = "",
    limit: int = 12,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DirectoryUser]:
    """Lightweight user directory for share-picker autocompletes.

    Every authenticated user can query this — sharing would be
    crippled if only admins could resolve handles to ids. Returns
    non-disabled accounts matching ``q`` (case-insensitive substring
    against both username and email) minus the caller themselves.

    Kept intentionally simple: no cursor / pagination, hard-capped
    result size, plain ``ILIKE`` filter. In practice Promptly
    deployments are small-team (tens to low hundreds of users) so a
    full scan with a prefix match stays well under 10ms on any
    reasonable Postgres box. Swap to a trigram index if the user
    table ever grows past that scale.
    """
    limit = max(1, min(30, limit))
    q_norm = q.strip()

    # Require a real search term (≥2 chars) so the directory can't be used to
    # dump the whole roster with an empty query — a public-host privacy fix.
    if len(q_norm) < 2:
        return []

    # Postgres ILIKE is case-insensitive; ``%``/``_`` in the term are escaped
    # so a user can't widen the match with wildcards. Matching still spans
    # username OR email (so you can find a colleague by their email) — but the
    # response never returns the email itself, so emails can't be harvested.
    escaped = q_norm.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    stmt = (
        select(User)
        .where(
            User.id != current_user.id,
            User.disabled.is_(False),
            or_(
                User.username.ilike(pattern, escape="\\"),
                User.email.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(User.username.asc())
        .limit(limit)
    )

    rows = (await db.execute(stmt)).scalars().all()
    # ``email`` intentionally omitted (defaults to None) — see DirectoryUser.
    return [
        DirectoryUser(
            user_id=u.id,
            username=u.username,
            avatar_url=u.avatar_url,
            avatar_color=u.avatar_color,
        )
        for u in rows
    ]


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


# --------------------------------------------------------------------
# Profile appearance — picture + initials-chip colour (0132)
# --------------------------------------------------------------------
_ALLOWED_AVATAR_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class ProfileUpdate(BaseModel):
    """Only appearance knobs live here — identity fields stay admin-only."""

    model_config = ConfigDict(extra="forbid")

    # "#RRGGBB" to set, None to clear back to the deterministic palette.
    avatar_color: str | None = None


@router.patch("/me/profile", response_model=UserResponse)
async def update_profile(
    payload: ProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    if payload.avatar_color is not None and not _HEX_COLOR_RE.match(
        payload.avatar_color
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Colour must be a #RRGGBB hex value.",
        )
    current_user.avatar_color = payload.avatar_color
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)


@router.post("/me/avatar", response_model=UserResponse)
async def upload_avatar(
    file: UploadFile,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Set the profile picture. The image is square-cropped, resized and
    re-encoded server-side, so the stored blob is always small and never
    the raw upload."""
    from app.auth.avatars import MAX_UPLOAD_BYTES, process_and_store

    if (file.content_type or "").lower() not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Use a PNG, JPEG, WEBP, or GIF image.",
        )
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Avatar images are capped at 5 MB.",
        )
    try:
        process_and_store(current_user, raw)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)
        ) from e
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)


@router.delete("/me/avatar", response_model=UserResponse)
async def delete_avatar(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    from app.auth.avatars import remove_avatar

    remove_avatar(current_user)
    await db.commit()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)


@router.get("/avatar/{user_id}")
async def serve_avatar(user_id: uuid.UUID, sig: str) -> Response:
    """Serve a processed avatar image.

    No session auth — ``<img src>`` can't send Bearer headers, so the
    HMAC in ``sig`` is the credential (same pattern as Drive document
    inline assets). The signature only unlocks *viewing an avatar*,
    which every authenticated user can do anyway via any payload that
    embeds the URL.
    """
    from fastapi.responses import FileResponse

    from app.auth.avatars import avatar_abs_path, verify_signature

    if not verify_signature(user_id, sig):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    path = avatar_abs_path(user_id)
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    return FileResponse(
        path,
        media_type="image/webp",
        headers={
            # The URL carries a ``v=`` cache-buster, so long immutable
            # caching is safe — a new upload mints a new URL.
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )

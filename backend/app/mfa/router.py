"""MFA HTTP surface — verify, enroll, manage, disable.

All endpoints live under ``/api/auth/mfa/*``.

Mounted by :mod:`app.main`. Three different auth modes are in play:

* ``Depends(get_current_user)``                 — already-logged-in
                                                   management endpoints
                                                   (status, settings).
* ``Depends(get_user_from_challenge_token)``    — login challenge
                                                   verify + email-OTP
                                                   resend.
* ``Depends(get_user_from_enrollment_token)``   — forced-enrollment
                                                   wizard endpoints.

The pattern is the same throughout: each handler does its work, writes
exactly one audit row describing the *outcome*, commits, and returns.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import (
    EVENT_MFA_BACKUP_USED,
    EVENT_MFA_DEVICE_REVOKED,
    EVENT_MFA_DEVICE_TRUSTED,
    EVENT_MFA_ENROLLED,
    EVENT_MFA_FAIL,
    EVENT_MFA_RESET,
    EVENT_MFA_VERIFIED,
    record_event,
    request_meta,
)
from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    create_access_token,
    create_refresh_token,
    decrypt_secret,
    encrypt_secret,
    verify_password,
)
from app.config import get_settings
from app.database import get_db
from app.mfa import backup as backup_codes
from app.mfa import service as mfa_service
from app.mfa import totp as totp_service
from app.mfa import trusted as trusted_devices
from app.mfa.deps import (
    get_user_from_challenge_token,
    get_user_from_enrollment_token,
)
from app.mfa.email_otp import (
    EmailOtpRateLimited,
    issue_and_send,
    verify as verify_email_otp,
)
from app.mfa.models import (
    METHOD_EMAIL,
    METHOD_TOTP,
    OTP_PURPOSE_ENROLLMENT,
    OTP_PURPOSE_LOGIN,
)
from app.mfa.schemas import (
    MfaBackupCodesResponse,
    MfaDisableRequest,
    MfaEmailEnrollRequest,
    MfaEmailEnrollResponse,
    MfaEmailEnrollVerifyRequest,
    MfaEmailSendResponse,
    MfaEnrollmentCompleteResponse,
    MfaStatusResponse,
    MfaTotpEnrollResponse,
    MfaTotpEnrollVerifyRequest,
    MfaTrustedDeviceResponse,
    MfaVerifyRequest,
)
from app.mfa.smtp import SmtpNotConfiguredError, SmtpSendError
from app.rate_limit import RateLimitMfaEmailSend, RateLimitMfaVerify

settings = get_settings()
router = APIRouter()

ACCESS_TOKEN_EXPIRE_SECONDS = ACCESS_TOKEN_EXPIRE_MINUTES * 60
REFRESH_TOKEN_EXPIRE_SECONDS = 7 * 24 * 60 * 60  # mirrors auth.utils

# Same generic error returned for every "code didn't verify" outcome
# so an attacker can't tell whether they had the wrong TOTP, an
# expired email OTP, an already-used backup code, or a stale
# challenge token.
GENERIC_VERIFY_FAIL = "Verification failed. Please try again."

REFRESH_COOKIE_NAME = "promptly_refresh"


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
def _set_refresh_cookie(response: Response, token: str) -> None:
    """Mirror of auth.router._set_refresh_cookie (kept private to avoid a
    cross-module import that would create a circular dependency)."""
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=REFRESH_TOKEN_EXPIRE_SECONDS,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        path="/api/auth",
    )


async def _issue_session(
    *,
    user: User,
    response: Response,
) -> tuple[str, int]:
    """Mint access + refresh + set the refresh cookie. Returns (access, ttl_s)."""
    access = create_access_token(user.id, token_version=user.token_version)
    refresh = create_refresh_token(user.id, token_version=user.token_version)
    _set_refresh_cookie(response, refresh)
    return access, ACCESS_TOKEN_EXPIRE_SECONDS


def _user_response(user: User):
    # Local import keeps the auth.schemas module out of MFA's import
    # graph at module load.
    from app.auth.schemas import UserResponse

    return UserResponse.model_validate(user)


# =====================================================================
# Status (already-authenticated)
# =====================================================================
@router.get("/status", response_model=MfaStatusResponse)
async def mfa_status(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MfaStatusResponse:
    secret = await mfa_service.get_secret(db, user_id=user.id)
    remaining = await backup_codes.remaining_count(db, user_id=user.id)
    devices = await trusted_devices.list_for_user(db, user_id=user.id)
    return MfaStatusResponse(
        enrolled=user.has_mfa,
        method=user.mfa_enrolled_method,  # type: ignore[arg-type]
        enrolled_at=user.mfa_enrolled_at,
        last_used_at=secret.last_used_at if secret else None,
        backup_codes_remaining=remaining,
        trusted_devices_count=len(devices),
    )


# =====================================================================
# Login challenge → verify
# =====================================================================
@router.post("/verify", response_model=MfaEnrollmentCompleteResponse)
async def mfa_verify(
    payload: MfaVerifyRequest,
    request: Request,
    response: Response,
    _rl: RateLimitMfaVerify,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_user_from_challenge_token),
) -> MfaEnrollmentCompleteResponse:
    """Trade an mfa_challenge token + a code for a real session.

    Accepts exactly one of TOTP / email OTP / backup code. Whichever
    factor verifies wins; the other slots are ignored. On success we
    optionally issue a 30-day trusted-device cookie.
    """
    if not user.has_mfa:
        # The user must have un-enrolled between challenge issue and
        # verify (e.g. an admin reset). Refuse cleanly — the frontend
        # will route them through enrollment on the next login.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="MFA is no longer enrolled for this account.",
        )

    secret = await mfa_service.get_secret(db, user_id=user.id)
    method_used: str | None = None

    # ---- Backup code ----
    # Tried first because backup codes are method-agnostic — a user
    # whose phone died can punch one in regardless of whether they
    # enrolled via TOTP or email.
    if payload.backup_code:
        if await backup_codes.verify_and_consume(
            db, user_id=user.id, submitted=payload.backup_code
        ):
            method_used = "backup"
            await record_event(
                db,
                request=request,
                event_type=EVENT_MFA_BACKUP_USED,
                user_id=user.id,
                identifier=user.username,
            )

    # ---- TOTP ----
    if method_used is None and payload.totp_code:
        if (
            secret is not None
            and secret.method == METHOD_TOTP
            and secret.totp_secret_encrypted
        ):
            try:
                plaintext = decrypt_secret(secret.totp_secret_encrypted)
            except ValueError:
                plaintext = ""
            if plaintext and totp_service.verify_code(plaintext, payload.totp_code):
                method_used = "totp"

    # ---- Email OTP ----
    if method_used is None and payload.email_code:
        if secret is not None and secret.method == METHOD_EMAIL:
            if await verify_email_otp(
                db,
                user_id=user.id,
                purpose=OTP_PURPOSE_LOGIN,
                submitted_code=payload.email_code,
            ):
                method_used = "email"

    if method_used is None:
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_FAIL,
            user_id=user.id,
            identifier=user.username,
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_VERIFY_FAIL,
        )

    # ---- Success path ----
    now = datetime.now(timezone.utc)
    if secret is not None:
        secret.last_used_at = now
    user.last_login_at = now
    ip, _ = request_meta(request)
    user.last_login_ip = ip[:64] or None

    await record_event(
        db,
        request=request,
        event_type=EVENT_MFA_VERIFIED,
        user_id=user.id,
        identifier=user.username,
        detail=f"method={method_used}",
    )

    if payload.trust_device:
        plaintext = await trusted_devices.issue(db, user_id=user.id, request=request)
        trusted_devices.set_trusted_cookie(response, plaintext)
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_DEVICE_TRUSTED,
            user_id=user.id,
            identifier=user.username,
        )

    access, ttl = await _issue_session(user=user, response=response)
    await db.commit()
    await db.refresh(user)

    return MfaEnrollmentCompleteResponse(
        user=_user_response(user),
        access_token=access,
        expires_in=ttl,
        method=user.mfa_enrolled_method,  # type: ignore[arg-type]
        # Verify path doesn't mint backup codes — only enrollment does.
        backup_codes=[],
    )


# =====================================================================
# Email OTP — re-send during login challenge
# =====================================================================
@router.post("/email/send", response_model=MfaEmailSendResponse)
async def mfa_email_send(
    request: Request,
    _rl: RateLimitMfaEmailSend,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_user_from_challenge_token),
) -> MfaEmailSendResponse:
    """(Re-)issue an email OTP for the user mid-login challenge.

    The frontend calls this when the user clicks "resend code", or on
    first paint of the email-method verify screen if no code is in
    flight yet.
    """
    if user.mfa_enrolled_method != METHOD_EMAIL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email-based MFA is not enrolled for this account.",
        )
    secret = await mfa_service.get_secret(db, user_id=user.id)
    to_address = (secret.email_address if secret else None) or user.email
    try:
        result = await issue_and_send(
            db,
            user_id=user.id,
            to_address=to_address,
            purpose=OTP_PURPOSE_LOGIN,
            request=request,
        )
    except EmailOtpRateLimited as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Please wait before requesting another code.",
            headers={"Retry-After": str(e.retry_after_seconds)},
        ) from e
    except SmtpNotConfiguredError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e),
        ) from e
    except SmtpSendError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to send verification email.",
        ) from e

    await db.commit()
    return MfaEmailSendResponse(
        sent=True,
        expires_in=int((result.expires_at - datetime.now(timezone.utc)).total_seconds()),
        email_hint=mfa_service.mask_email(to_address),
    )


# =====================================================================
# Enrollment — TOTP
# =====================================================================
@router.post("/setup/totp", response_model=MfaTotpEnrollResponse)
async def mfa_setup_totp(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MfaTotpEnrollResponse:
    """Begin TOTP enrollment for an already-authenticated user.

    Wipes any in-progress secret and mints a fresh one. The user has
    until they hit /setup/totp/verify to scan it; failing to verify
    leaves the row in place but inactive (it doesn't gate login).
    """
    return await _begin_totp_enrollment(db, user=user)


@router.post("/setup/totp/forced", response_model=MfaTotpEnrollResponse)
async def mfa_setup_totp_forced(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_user_from_enrollment_token),
) -> MfaTotpEnrollResponse:
    """Begin TOTP enrollment when forced by ``mfa_required``."""
    return await _begin_totp_enrollment(db, user=user)


async def _begin_totp_enrollment(
    db: AsyncSession,
    *,
    user: User,
) -> MfaTotpEnrollResponse:
    secret = totp_service.generate_secret()
    encrypted = encrypt_secret(secret)
    await mfa_service.upsert_pending(
        db,
        user_id=user.id,
        method=METHOD_TOTP,
        totp_secret_encrypted=encrypted,
    )
    await db.commit()

    uri = totp_service.provisioning_uri(
        secret, account_name=user.email
    )
    return MfaTotpEnrollResponse(
        secret=secret,
        otpauth_uri=uri,
        qr_data_uri=totp_service.qr_data_uri(uri),
    )


@router.post("/setup/totp/verify", response_model=MfaEnrollmentCompleteResponse)
async def mfa_setup_totp_verify(
    payload: MfaTotpEnrollVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MfaEnrollmentCompleteResponse:
    return await _commit_totp_enrollment(
        payload=payload,
        request=request,
        response=response,
        db=db,
        user=user,
        issue_session=False,
    )


@router.post(
    "/setup/totp/verify/forced",
    response_model=MfaEnrollmentCompleteResponse,
)
async def mfa_setup_totp_verify_forced(
    payload: MfaTotpEnrollVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_user_from_enrollment_token),
) -> MfaEnrollmentCompleteResponse:
    """Same as /setup/totp/verify but accepts the enrollment token and
    issues real session tokens on success — finishing the forced
    enrollment flow without a separate login round-trip."""
    return await _commit_totp_enrollment(
        payload=payload,
        request=request,
        response=response,
        db=db,
        user=user,
        issue_session=True,
    )


async def _commit_totp_enrollment(
    *,
    payload: MfaTotpEnrollVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession,
    user: User,
    issue_session: bool,
) -> MfaEnrollmentCompleteResponse:
    secret = await mfa_service.get_secret(db, user_id=user.id)
    if (
        secret is None
        or secret.method != METHOD_TOTP
        or not secret.totp_secret_encrypted
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No pending TOTP enrollment. Restart the setup flow.",
        )
    try:
        plaintext = decrypt_secret(secret.totp_secret_encrypted)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Stored TOTP secret could not be decrypted.",
        ) from e

    if not totp_service.verify_code(plaintext, payload.code):
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_FAIL,
            user_id=user.id,
            identifier=user.username,
            detail="enroll_totp_wrong_code",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_VERIFY_FAIL,
        )

    plaintext_codes = backup_codes.generate_codes()
    await backup_codes.replace_codes_for_user(
        db,
        user_id=user.id,
        plaintext_codes=plaintext_codes,
    )
    await mfa_service.mark_enrolled(db, user=user, secret=secret)
    await record_event(
        db,
        request=request,
        event_type=EVENT_MFA_ENROLLED,
        user_id=user.id,
        identifier=user.username,
        detail="method=totp",
    )

    access = ""
    ttl = 0
    if issue_session:
        access, ttl = await _issue_session(user=user, response=response)

    await db.commit()
    await db.refresh(user)

    return MfaEnrollmentCompleteResponse(
        user=_user_response(user),
        access_token=access,
        expires_in=ttl,
        method=METHOD_TOTP,
        backup_codes=plaintext_codes,
    )


# =====================================================================
# Enrollment — Email
# =====================================================================
@router.post("/setup/email", response_model=MfaEmailEnrollResponse)
async def mfa_setup_email(
    payload: MfaEmailEnrollRequest,
    request: Request,
    _rl: RateLimitMfaEmailSend,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MfaEmailEnrollResponse:
    return await _begin_email_enrollment(
        payload=payload, request=request, db=db, user=user
    )


@router.post("/setup/email/forced", response_model=MfaEmailEnrollResponse)
async def mfa_setup_email_forced(
    payload: MfaEmailEnrollRequest,
    request: Request,
    _rl: RateLimitMfaEmailSend,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_user_from_enrollment_token),
) -> MfaEmailEnrollResponse:
    return await _begin_email_enrollment(
        payload=payload, request=request, db=db, user=user
    )


async def _begin_email_enrollment(
    *,
    payload: MfaEmailEnrollRequest,
    request: Request,
    db: AsyncSession,
    user: User,
) -> MfaEmailEnrollResponse:
    to_address = (
        str(payload.email_address) if payload.email_address else user.email
    )
    await mfa_service.upsert_pending(
        db,
        user_id=user.id,
        method=METHOD_EMAIL,
        email_address=to_address,
    )
    try:
        result = await issue_and_send(
            db,
            user_id=user.id,
            to_address=to_address,
            purpose=OTP_PURPOSE_ENROLLMENT,
            request=request,
        )
    except EmailOtpRateLimited as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Please wait before requesting another code.",
            headers={"Retry-After": str(e.retry_after_seconds)},
        ) from e
    except SmtpNotConfiguredError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e),
        ) from e
    except SmtpSendError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to send verification email.",
        ) from e

    await db.commit()
    return MfaEmailEnrollResponse(
        sent=True,
        expires_in=int(
            (result.expires_at - datetime.now(timezone.utc)).total_seconds()
        ),
        email_hint=mfa_service.mask_email(to_address),
    )


@router.post("/setup/email/verify", response_model=MfaEnrollmentCompleteResponse)
async def mfa_setup_email_verify(
    payload: MfaEmailEnrollVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MfaEnrollmentCompleteResponse:
    return await _commit_email_enrollment(
        payload=payload,
        request=request,
        response=response,
        db=db,
        user=user,
        issue_session=False,
    )


@router.post(
    "/setup/email/verify/forced",
    response_model=MfaEnrollmentCompleteResponse,
)
async def mfa_setup_email_verify_forced(
    payload: MfaEmailEnrollVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_user_from_enrollment_token),
) -> MfaEnrollmentCompleteResponse:
    return await _commit_email_enrollment(
        payload=payload,
        request=request,
        response=response,
        db=db,
        user=user,
        issue_session=True,
    )


async def _commit_email_enrollment(
    *,
    payload: MfaEmailEnrollVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession,
    user: User,
    issue_session: bool,
) -> MfaEnrollmentCompleteResponse:
    secret = await mfa_service.get_secret(db, user_id=user.id)
    if secret is None or secret.method != METHOD_EMAIL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No pending email enrollment. Restart the setup flow.",
        )

    if not await verify_email_otp(
        db,
        user_id=user.id,
        purpose=OTP_PURPOSE_ENROLLMENT,
        submitted_code=payload.code,
    ):
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_FAIL,
            user_id=user.id,
            identifier=user.username,
            detail="enroll_email_wrong_code",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_VERIFY_FAIL,
        )

    plaintext_codes = backup_codes.generate_codes()
    await backup_codes.replace_codes_for_user(
        db,
        user_id=user.id,
        plaintext_codes=plaintext_codes,
    )
    await mfa_service.mark_enrolled(db, user=user, secret=secret)
    await record_event(
        db,
        request=request,
        event_type=EVENT_MFA_ENROLLED,
        user_id=user.id,
        identifier=user.username,
        detail="method=email",
    )

    access = ""
    ttl = 0
    if issue_session:
        access, ttl = await _issue_session(user=user, response=response)

    await db.commit()
    await db.refresh(user)

    return MfaEnrollmentCompleteResponse(
        user=_user_response(user),
        access_token=access,
        expires_in=ttl,
        method=METHOD_EMAIL,
        backup_codes=plaintext_codes,
    )


# =====================================================================
# Backup codes — regenerate
# =====================================================================
@router.post(
    "/backup-codes/regenerate", response_model=MfaBackupCodesResponse
)
async def mfa_regenerate_backup_codes(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MfaBackupCodesResponse:
    if not user.has_mfa:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="MFA must be enrolled before generating backup codes.",
        )
    plaintext_codes = backup_codes.generate_codes()
    await backup_codes.replace_codes_for_user(
        db, user_id=user.id, plaintext_codes=plaintext_codes
    )
    await record_event(
        db,
        request=request,
        event_type=EVENT_MFA_RESET,
        user_id=user.id,
        identifier=user.username,
        detail="backup_codes_regenerated",
    )
    await db.commit()
    return MfaBackupCodesResponse(codes=plaintext_codes)


# =====================================================================
# Disable
# =====================================================================
@router.post("/disable", status_code=status.HTTP_204_NO_CONTENT)
async def mfa_disable(
    payload: MfaDisableRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Tear down MFA after re-confirming password + current second factor."""
    if not user.has_mfa:
        # Idempotent — already disabled.
        response.status_code = status.HTTP_204_NO_CONTENT
        return response

    if not verify_password(payload.password, user.password_hash):
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_FAIL,
            user_id=user.id,
            identifier=user.username,
            detail="disable_wrong_password",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_VERIFY_FAIL,
        )

    secret = await mfa_service.get_secret(db, user_id=user.id)
    code_ok = False
    # Try TOTP / email OTP / backup code in turn — same broad acceptance
    # as /verify so the user can disable from any working factor.
    if secret is not None and secret.method == METHOD_TOTP and secret.totp_secret_encrypted:
        try:
            plaintext = decrypt_secret(secret.totp_secret_encrypted)
            code_ok = totp_service.verify_code(plaintext, payload.code)
        except ValueError:
            code_ok = False
    if not code_ok and secret is not None and secret.method == METHOD_EMAIL:
        code_ok = await verify_email_otp(
            db,
            user_id=user.id,
            purpose=OTP_PURPOSE_LOGIN,
            submitted_code=payload.code,
        )
    if not code_ok:
        code_ok = await backup_codes.verify_and_consume(
            db, user_id=user.id, submitted=payload.code
        )

    if not code_ok:
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_FAIL,
            user_id=user.id,
            identifier=user.username,
            detail="disable_wrong_code",
        )
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=GENERIC_VERIFY_FAIL,
        )

    await mfa_service.disable_for_user(db, user=user)
    await record_event(
        db,
        request=request,
        event_type=EVENT_MFA_RESET,
        user_id=user.id,
        identifier=user.username,
        detail="self_disable",
    )
    trusted_devices.clear_trusted_cookie(response)
    await db.commit()

    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# =====================================================================
# Trusted devices — list / revoke
# =====================================================================
@router.get(
    "/trusted-devices", response_model=list[MfaTrustedDeviceResponse]
)
async def list_trusted_devices(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MfaTrustedDeviceResponse]:
    rows = await trusted_devices.list_for_user(db, user_id=user.id)
    return [MfaTrustedDeviceResponse.model_validate(r) for r in rows]


@router.delete(
    "/trusted-devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def revoke_trusted_device(
    device_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    import uuid as _uuid

    try:
        dev_id = _uuid.UUID(device_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Device not found"
        ) from e

    deleted = await trusted_devices.revoke(db, user_id=user.id, device_id=dev_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Device not found"
        )
    await record_event(
        db,
        request=request,
        event_type=EVENT_MFA_DEVICE_REVOKED,
        user_id=user.id,
        identifier=user.username,
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/trusted-devices", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_all_trusted_devices(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    n = await trusted_devices.revoke_all(db, user_id=user.id)
    if n:
        await record_event(
            db,
            request=request,
            event_type=EVENT_MFA_DEVICE_REVOKED,
            user_id=user.id,
            identifier=user.username,
            detail=f"all (count={n})",
        )
        await db.commit()
    trusted_devices.clear_trusted_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response

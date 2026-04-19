"""Pydantic schemas for the MFA HTTP surface."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.auth.schemas import UserResponse

# Method literal mirrored from app.mfa.models. Kept as a typing.Literal
# (not the str constant) so OpenAPI / TypeScript codegen surfaces the
# enumerated values for client tooling.
MfaMethod = Literal["totp", "email"]


# ---------------------------------------------------------------------
# Login-flow responses (returned by /auth/login when MFA is required)
# ---------------------------------------------------------------------
class MfaChallengeResponse(BaseModel):
    """Issued by /auth/login when the user has MFA enrolled.

    The frontend must POST the user's code to /auth/mfa/verify with
    this token in the Authorization header. No access token is granted
    until verification succeeds.
    """

    status: Literal["mfa_required"] = "mfa_required"
    method: MfaMethod
    challenge_token: str
    expires_in: int
    # Only populated when method == "email" — masked for display
    # ("a***@example.com"). The frontend uses this to render
    # "We sent a code to ..." without leaking the full address.
    email_hint: str | None = None


class MfaEnrollmentRequiredResponse(BaseModel):
    """Issued by /auth/login when ``app_settings.mfa_required`` is on
    but the user has no method enrolled yet.

    The frontend must walk the user through the enrollment wizard,
    presenting this token to /auth/mfa/setup/* endpoints. A real
    access token is only granted after the first verify succeeds.
    """

    status: Literal["mfa_enrollment_required"] = "mfa_enrollment_required"
    enrollment_token: str
    expires_in: int


# ---------------------------------------------------------------------
# Verify (login challenge → real tokens)
# ---------------------------------------------------------------------
class MfaVerifyRequest(BaseModel):
    """Submitted to POST /auth/mfa/verify.

    Exactly one of ``totp_code``, ``email_code``, or ``backup_code``
    should be set — but we don't enforce that with a model_validator
    so the endpoint can return a single generic error and not leak
    which factor the user picked.
    """

    totp_code: str | None = Field(default=None, max_length=10)
    email_code: str | None = Field(default=None, max_length=10)
    backup_code: str | None = Field(default=None, max_length=20)
    # When True, the verify endpoint also issues a 30-day
    # trusted-device cookie so this device can skip the second
    # factor on subsequent logins.
    trust_device: bool = False


# ---------------------------------------------------------------------
# Email OTP (send during login challenge)
# ---------------------------------------------------------------------
class MfaEmailSendResponse(BaseModel):
    """Issued by POST /auth/mfa/email/send (during login challenge)."""

    sent: bool = True
    expires_in: int
    email_hint: str


# ---------------------------------------------------------------------
# Enrollment — TOTP
# ---------------------------------------------------------------------
class MfaTotpEnrollResponse(BaseModel):
    """Returned by POST /auth/mfa/setup/totp.

    The client should render the QR (data URI), let the user scan it,
    then POST the resulting code to /auth/mfa/setup/totp/verify. The
    secret is also surfaced as text for users whose authenticator
    can't scan QRs (mostly password managers entering setup keys
    manually).
    """

    secret: str
    otpauth_uri: str
    qr_data_uri: str


class MfaTotpEnrollVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=10)


# ---------------------------------------------------------------------
# Enrollment — Email
# ---------------------------------------------------------------------
class MfaEmailEnrollRequest(BaseModel):
    """Sent to POST /auth/mfa/setup/email — the user picks the inbox."""

    email_address: EmailStr | None = None
    """If omitted, the user's account email is used."""


class MfaEmailEnrollResponse(BaseModel):
    sent: bool = True
    expires_in: int
    email_hint: str


class MfaEmailEnrollVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=10)


# ---------------------------------------------------------------------
# Common — backup codes returned exactly once
# ---------------------------------------------------------------------
class MfaEnrollmentCompleteResponse(BaseModel):
    """Returned when an MFA setup verify succeeds.

    Includes the backup codes — this is the *one and only* time they
    are sent down the wire in plaintext. Includes a real access token
    + the user payload so the frontend can finish the login.
    """

    user: UserResponse
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    method: MfaMethod
    backup_codes: list[str]


# ---------------------------------------------------------------------
# Settings panel (authenticated)
# ---------------------------------------------------------------------
class MfaStatusResponse(BaseModel):
    """Returned by GET /auth/mfa/status."""

    enrolled: bool
    method: MfaMethod | None = None
    enrolled_at: datetime | None = None
    last_used_at: datetime | None = None
    backup_codes_remaining: int = 0
    trusted_devices_count: int = 0


class MfaTrustedDeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    ip: str
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime


class MfaBackupCodesResponse(BaseModel):
    """Returned by POST /auth/mfa/backup-codes/regenerate.

    The plaintext codes leave the server exactly once; a hash is what
    we keep.
    """

    codes: list[str]


class MfaDisableRequest(BaseModel):
    """Re-prove identity before tearing down MFA.

    Both fields are required:

    * ``password`` — confirms it's actually the account owner, not
      someone who walked up to an unlocked browser.
    * ``code`` — current TOTP / email OTP / backup code, so the
      attacker also can't bypass MFA without the second factor.
    """

    password: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=4, max_length=20)

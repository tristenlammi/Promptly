"""Native MFA: TOTP + email OTP, backup codes, trusted devices.

Adds the schema needed by Phase 2 (multi-factor auth):

* ``users.mfa_enrolled_method`` / ``users.mfa_enrolled_at`` — denormalised
  flags so the auth router can answer "does this user have MFA?" without
  joining four other tables on the hot login path.
* ``user_mfa_secrets`` — one row per enrolled user. Holds the TOTP shared
  secret (Fernet-encrypted at rest) or the chosen email address for email
  OTP, plus telemetry for the user's MFA settings page.
* ``mfa_backup_codes`` — ten one-shot recovery codes per user, hashed with
  bcrypt so a stolen DB dump can't be replayed. ``used_at`` flips when a
  code is consumed.
* ``mfa_trusted_devices`` — opaque tokens (sha256-hashed in the DB,
  plaintext only in the user's HttpOnly cookie) that let a known device
  skip the verify step for ``MFA_TRUSTED_DEVICE_DAYS`` after the user
  ticked "trust this device".
* ``email_otp_challenges`` — short-lived 6-digit codes used both during
  login (when the user's chosen method is email) and during email-method
  enrollment. ``attempts`` is capped on the read side to thwart guessing.

Revision ID: 0008_mfa
Revises: 0007_security_foundation
Create Date: 2026-04-20 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008_mfa"
down_revision: Union[str, Sequence[str], None] = "0007_security_foundation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ----------------------------------------------------------------
    # users — denormalised MFA status
    # ----------------------------------------------------------------
    # Stored on ``users`` (not just on ``user_mfa_secrets``) because
    # the login hot path needs to know "is this user enrolled, and via
    # which method?" with a single SELECT. ``mfa_enrolled_method`` is
    # NULL when the user has never enrolled, "totp" or "email" once
    # enrollment has been *verified*. An in-progress (unverified) row
    # lives in ``user_mfa_secrets`` but does not flip these columns —
    # so an attacker who manages to insert a half-baked secret can't
    # trick the login flow into bypassing the password check.
    op.add_column(
        "users",
        sa.Column("mfa_enrolled_method", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "mfa_enrolled_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )

    # ----------------------------------------------------------------
    # user_mfa_secrets — one row per user (UNIQUE on user_id)
    # ----------------------------------------------------------------
    op.create_table(
        "user_mfa_secrets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        # "totp" or "email". Settable while enrollment is in progress;
        # the matching column on ``users`` only flips once verified.
        sa.Column("method", sa.String(length=16), nullable=False),
        # base32 TOTP secret, Fernet-encrypted with the app SECRET_KEY.
        # NULL for email-method users.
        sa.Column("totp_secret_encrypted", sa.Text(), nullable=True),
        # Email address used for OTP delivery. Defaults to the user's
        # primary email but stored independently so the user can route
        # codes to a different inbox without changing their login
        # identifier.
        sa.Column("email_address", sa.String(length=320), nullable=True),
        # Set when the user successfully verifies their first code.
        # Until then the row exists but the user is treated as not
        # enrolled (and login still goes straight through).
        sa.Column("enrolled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ----------------------------------------------------------------
    # mfa_backup_codes — 10 per user, hashed, single-use
    # ----------------------------------------------------------------
    op.create_table(
        "mfa_backup_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # bcrypt hash. We store *hashed* codes so a DB leak can't be
        # replayed against MFA — it forces the attacker to brute-force
        # each bcrypt round per code per user.
        sa.Column("code_hash", sa.String(length=255), nullable=False),
        # NULL = unused, non-NULL = consumed at this timestamp. We never
        # delete a used code (so the audit log retains a stable
        # reference) — we just refuse to verify against it.
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ----------------------------------------------------------------
    # mfa_trusted_devices — opaque cookie tokens, sha256 in the DB
    # ----------------------------------------------------------------
    op.create_table(
        "mfa_trusted_devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # sha256 of the plaintext token that lives in the user's cookie.
        # sha256 (not bcrypt) because: (a) the token is already 256 bits
        # of entropy, so a fast hash is fine; (b) we look this up on
        # every login and bcrypt-per-row is too slow.
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True),
        # User-Agent at the moment the device was trusted. Cosmetic —
        # shown in the "trusted devices" list so the user can recognise
        # which entry to revoke.
        sa.Column("label", sa.String(length=512), nullable=False, server_default=""),
        # IP address at trust time, also cosmetic. Cloudflare-aware
        # (extracted via the same ``request_meta`` helper as the audit
        # log).
        sa.Column("ip", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    # Composite index for the eventual "revoke all expired" sweeper.
    op.create_index(
        "ix_mfa_trusted_devices_user_expires",
        "mfa_trusted_devices",
        ["user_id", "expires_at"],
    )

    # ----------------------------------------------------------------
    # email_otp_challenges — short-lived, single-use, attempt-capped
    # ----------------------------------------------------------------
    op.create_table(
        "email_otp_challenges",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # sha256 of the 6-digit code. Fast hash is fine — the keyspace
        # is one million but ``attempts`` capped at 5 makes brute force
        # effectively impossible regardless of hash speed.
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        # "login" or "enrollment" so a code minted for one purpose
        # can't be used for the other.
        sa.Column("purpose", sa.String(length=16), nullable=False),
        # Bumped on every wrong guess. Verify refuses once attempts >= 5.
        sa.Column(
            "attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        # Source IP at send time — useful for spotting abuse.
        sa.Column("ip", sa.String(length=64), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_email_otp_challenges_user_purpose_created",
        "email_otp_challenges",
        ["user_id", "purpose", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_email_otp_challenges_user_purpose_created",
        table_name="email_otp_challenges",
    )
    op.drop_table("email_otp_challenges")
    op.drop_index(
        "ix_mfa_trusted_devices_user_expires",
        table_name="mfa_trusted_devices",
    )
    op.drop_table("mfa_trusted_devices")
    op.drop_table("mfa_backup_codes")
    op.drop_table("user_mfa_secrets")
    op.drop_column("users", "mfa_enrolled_at")
    op.drop_column("users", "mfa_enrolled_method")

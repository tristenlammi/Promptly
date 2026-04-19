"""Security foundation: account lockout, audit log, app settings.

Adds the schema needed by every Phase-1+ security feature:

* New columns on ``users`` for lockout, disable, forced password change,
  token revocation (``token_version``), and last-login telemetry.
* New ``auth_events`` table — append-only audit log of every
  security-relevant action (login attempts, lockouts, admin overrides,
  MFA enrollment, etc.).
* New ``app_settings`` table — single-row global runtime configuration
  (``mfa_required`` toggle, SMTP credentials, future feature flags).
  The single row is seeded with ``id =
  '00000000-0000-0000-0000-000000000001'`` so the application can rely
  on its existence without a get-or-create dance.

Revision ID: 0007_security_foundation
Revises: 0006_files
Create Date: 2026-04-19 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007_security_foundation"
down_revision: Union[str, Sequence[str], None] = "0006_files"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Sentinel UUID for the single app_settings row. Lets the app load it
# with ``db.get(AppSettings, APP_SETTINGS_ID)`` without a query.
SINGLETON_APP_SETTINGS_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    # ----------------------------------------------------------------
    # users — security columns
    # ----------------------------------------------------------------
    op.add_column(
        "users",
        sa.Column(
            "failed_login_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "locked_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "disabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Embedded in every JWT (`tv` claim). Bumping it instantly
    # invalidates every outstanding access + refresh token for the user
    # — used on lockout, disable, password change, MFA reset, and the
    # explicit "log me out everywhere" button.
    op.add_column(
        "users",
        sa.Column(
            "token_version",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "last_login_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            # Stored as text rather than INET so we can keep raw values
            # like "unknown" or X-Forwarded-For chains for diagnostics.
            "last_login_ip",
            sa.String(length=64),
            nullable=True,
        ),
    )

    # ----------------------------------------------------------------
    # auth_events — append-only audit log
    # ----------------------------------------------------------------
    op.create_table(
        "auth_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        # The identifier the caller *typed* on a login attempt — kept
        # even when no matching user exists (NULL user_id) so we can
        # spot enumeration attempts. Capped at 320 chars (RFC 5321 max
        # email length).
        sa.Column("identifier", sa.String(length=320), nullable=False, server_default=""),
        sa.Column("ip", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("user_agent", sa.String(length=512), nullable=False, server_default=""),
        sa.Column("event_type", sa.String(length=48), nullable=False),
        sa.Column("detail", sa.String(length=512), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_auth_events_event_type_created_at",
        "auth_events",
        ["event_type", "created_at"],
    )
    op.create_index(
        "ix_auth_events_ip_created_at",
        "auth_events",
        ["ip", "created_at"],
    )

    # ----------------------------------------------------------------
    # app_settings — single-row global config
    # ----------------------------------------------------------------
    op.create_table(
        "app_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),

        # MFA master switch. When False, login is password-only (current
        # behavior). When True, every user without MFA enrolled is
        # force-routed to enrollment on next login.
        sa.Column(
            "mfa_required",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),

        # SMTP configuration. Stored here (not in env) so the admin can
        # change it from the UI without restarting the container.
        sa.Column("smtp_host", sa.String(length=255), nullable=True),
        sa.Column("smtp_port", sa.Integer(), nullable=True),
        sa.Column("smtp_username", sa.String(length=255), nullable=True),
        # Fernet-encrypted at rest. See app.auth.utils.encrypt_secret.
        sa.Column("smtp_password_encrypted", sa.Text(), nullable=True),
        sa.Column(
            "smtp_use_tls",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("smtp_from_address", sa.String(length=320), nullable=True),
        sa.Column("smtp_from_name", sa.String(length=128), nullable=True),

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

    # Seed the single row so application code can rely on it being
    # there. The id is a hard-coded sentinel UUID — inlined as a SQL
    # literal (with explicit ::uuid cast) so we don't have to fight
    # asyncpg's parameter type inference.
    op.execute(
        sa.text(
            "INSERT INTO app_settings (id) VALUES "
            f"('{SINGLETON_APP_SETTINGS_ID}'::uuid) ON CONFLICT DO NOTHING"
        )
    )


def downgrade() -> None:
    op.drop_table("app_settings")
    op.drop_index("ix_auth_events_ip_created_at", table_name="auth_events")
    op.drop_index("ix_auth_events_event_type_created_at", table_name="auth_events")
    op.drop_table("auth_events")
    op.drop_column("users", "last_login_ip")
    op.drop_column("users", "last_login_at")
    op.drop_column("users", "token_version")
    op.drop_column("users", "must_change_password")
    op.drop_column("users", "disabled")
    op.drop_column("users", "locked_at")
    op.drop_column("users", "failed_login_attempts")

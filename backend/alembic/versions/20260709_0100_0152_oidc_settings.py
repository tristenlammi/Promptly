"""OIDC single sign-on settings.

Adds the OIDC/SSO columns to the ``app_settings`` singleton. All nullable /
default-off, so a fresh or upgraded install behaves exactly as before until
an admin turns SSO on. The client secret is Fernet-encrypted at rest,
mirroring ``smtp_password_encrypted``.

Revision ID: 0152_oidc_settings
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0152_oidc_settings"
down_revision = "0151_conv_visibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "oidc_enabled",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.add_column(
        "app_settings", sa.Column("oidc_issuer", sa.String(length=512), nullable=True)
    )
    op.add_column(
        "app_settings",
        sa.Column("oidc_client_id", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("oidc_client_secret_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "app_settings",
        sa.Column("oidc_button_label", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "app_settings", sa.Column("oidc_scopes", sa.String(length=256), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("app_settings", "oidc_scopes")
    op.drop_column("app_settings", "oidc_button_label")
    op.drop_column("app_settings", "oidc_client_secret_encrypted")
    op.drop_column("app_settings", "oidc_client_id")
    op.drop_column("app_settings", "oidc_issuer")
    op.drop_column("app_settings", "oidc_enabled")

"""SSO binds to (issuer, subject); verified email and MFA by default (R-140).

Revision ID: 0179_sso_identity_binding
Revises: 0178_mfa_pending_factor
"""
from alembic import op
import sqlalchemy as sa

revision = "0179_sso_identity_binding"
down_revision = "0178_mfa_pending_factor"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("oidc_issuer", sa.String(512), nullable=True))
    op.add_column("users", sa.Column("oidc_subject", sa.String(255), nullable=True))
    op.create_index(
        "uq_users_oidc_identity", "users", ["oidc_issuer", "oidc_subject"], unique=True,
        postgresql_where=sa.text("oidc_subject IS NOT NULL"),
    )
    op.add_column(
        "app_settings",
        sa.Column("oidc_trust_unverified_email", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "app_settings",
        sa.Column("oidc_satisfies_mfa", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "oidc_satisfies_mfa")
    op.drop_column("app_settings", "oidc_trust_unverified_email")
    op.drop_index("uq_users_oidc_identity", table_name="users")
    op.drop_column("users", "oidc_subject")
    op.drop_column("users", "oidc_issuer")

"""A new MFA factor is held apart until verified (R-141).

Revision ID: 0178_mfa_pending_factor
Revises: 0177_backup_code_lookup
"""
from alembic import op
import sqlalchemy as sa

revision = "0178_mfa_pending_factor"
down_revision = "0177_backup_code_lookup"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_mfa_secrets", sa.Column("pending_method", sa.String(16), nullable=True))
    op.add_column("user_mfa_secrets", sa.Column("pending_totp_secret_encrypted", sa.Text(), nullable=True))
    op.add_column("user_mfa_secrets", sa.Column("pending_email_address", sa.String(320), nullable=True))


def downgrade() -> None:
    for col in ("pending_email_address", "pending_totp_secret_encrypted", "pending_method"):
        op.drop_column("user_mfa_secrets", col)

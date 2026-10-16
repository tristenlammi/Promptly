"""Backup codes get a keyed lookup so a guess checks one row (R-139).

Revision ID: 0177_backup_code_lookup
Revises: 0176_conv_disabled_connectors
"""
from alembic import op
import sqlalchemy as sa

revision = "0177_backup_code_lookup"
down_revision = "0176_conv_disabled_connectors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mfa_backup_codes", sa.Column("lookup", sa.String(64), nullable=True))
    op.create_index("ix_mfa_backup_codes_lookup", "mfa_backup_codes", ["lookup"])


def downgrade() -> None:
    op.drop_index("ix_mfa_backup_codes_lookup", table_name="mfa_backup_codes")
    op.drop_column("mfa_backup_codes", "lookup")

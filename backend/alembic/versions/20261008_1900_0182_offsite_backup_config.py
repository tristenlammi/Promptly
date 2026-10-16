"""Off-site backup target (WP-2.3, D11).

Revision ID: 0182_offsite_backup_config
Revises: 0181_user_last_seen
"""
from alembic import op
import sqlalchemy as sa

revision = "0182_offsite_backup_config"
down_revision = "0181_user_last_seen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("backup_runs", sa.Column("detail", sa.Text(), nullable=True))
    op.create_table(
        "offsite_backup_config",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("target_kind", sa.String(16), nullable=False, server_default="folder"),
        sa.Column("location", sa.Text(), nullable=False, server_default=""),
        sa.Column("credentials_encrypted", sa.Text(), nullable=True),
        sa.Column("repo_password_encrypted", sa.Text(), nullable=True),
        sa.Column("hour", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("keep_daily", sa.Integer(), nullable=False, server_default="7"),
        sa.Column("keep_weekly", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("keep_monthly", sa.Integer(), nullable=False, server_default="12"),
        sa.Column("restore_test_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def downgrade() -> None:
    op.drop_table("offsite_backup_config")
    op.drop_column("backup_runs", "detail")

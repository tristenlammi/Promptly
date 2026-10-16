"""Workspace trash (R-177): deleting a workspace is restorable for 30 days.
Plus ``is_template`` (R-204): a workspace saved as a template for new ones.

Revision ID: 0183_workspace_trash
Revises: 0182_offsite_backup_config
"""
from alembic import op
import sqlalchemy as sa

revision = "0183_workspace_trash"
down_revision = "0182_offsite_backup_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_workspaces_trashed_at",
        "workspaces",
        ["trashed_at"],
        postgresql_where=sa.text("trashed_at IS NOT NULL"),
    )
    op.add_column(
        "workspaces",
        sa.Column(
            "is_template",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "is_template")
    op.drop_index("ix_workspaces_trashed_at", table_name="workspaces")
    op.drop_column("workspaces", "trashed_at")

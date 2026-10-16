"""Sheet version history (R-132): periodic snapshots of a spreadsheet's
workbook, so a bad edit, import or clear can be undone. Plus ``edited_at``
on item and card comments, which can now be edited (R-202).

Revision ID: 0184_spreadsheet_versions
Revises: 0183_workspace_trash
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0184_spreadsheet_versions"
down_revision = "0183_workspace_trash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "spreadsheet_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "spreadsheet_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("spreadsheets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("data", postgresql.JSONB(), nullable=True),
        sa.Column("cell_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reason", sa.String(16), nullable=False, server_default="autosave"),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_spreadsheet_versions_sheet_created",
        "spreadsheet_versions",
        ["spreadsheet_id", "created_at"],
    )
    for table in ("workspace_item_comments", "workspace_task_comments"):
        op.add_column(table, sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True))
    # Boards, notebooks and discussions were created without a creator;
    # attribute them to the workspace's owner.
    op.execute(
        """
        UPDATE workspace_items wi SET created_by = w.user_id
        FROM workspaces w
        WHERE wi.workspace_id = w.id AND wi.created_by IS NULL
          AND wi.kind IN ('board', 'container', 'discussion')
        """
    )


def downgrade() -> None:
    for table in ("workspace_item_comments", "workspace_task_comments"):
        op.drop_column(table, "edited_at")
    op.drop_index("ix_spreadsheet_versions_sheet_created", table_name="spreadsheet_versions")
    op.drop_table("spreadsheet_versions")

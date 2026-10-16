"""Who opened or edited which file, and when — Recent (WP-3.4, Part C §3.5).

Recent used the file's own update time, so it only ever listed the caller's
files and reordered on a star or move. ``file_activity`` keeps the latest
"opened" and "edited" time per user and file (one row each, upserted), so
Recent includes files shared with you and workspace files you worked on.

Revision ID: 0191_file_activity
Revises: 0190_file_versions
"""
from alembic import op
import sqlalchemy as sa

revision = "0191_file_activity"
down_revision = "0190_file_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "file_activity",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("user_id", "file_id", "kind"),
        sa.CheckConstraint("kind IN ('opened','edited')", name="ck_file_activity_kind"),
    )
    op.create_index("ix_file_activity_user_at", "file_activity", ["user_id", sa.text("at DESC")])


def downgrade() -> None:
    op.drop_index("ix_file_activity_user_at", table_name="file_activity")
    op.drop_table("file_activity")

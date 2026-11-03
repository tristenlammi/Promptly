"""One trash across apps: ``trash_entries``.

Drive files/folders, workspace items and workspaces already soft-delete in
place (``trashed_at``) and the unified trash reads them there. Apps that
hard-deleted — calendar events, albums, and tasks / contacts inside item
files — now keep a snapshot of what was deleted here for 30 days, so it
can be restored. No existing table changes.

Revision ID: 0236_trash
Revises: 0235_tags
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0236_trash"
down_revision = "0235_tags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trash_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("deleted_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("title", sa.String(300), nullable=False, server_default=""),
        sa.Column("source_id", sa.String(64), nullable=False),
        sa.Column("container_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("location", sa.String(300), nullable=False, server_default=""),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "kind IN ('calendar_event', 'album', 'task', 'contact')", name="ck_trash_entries_kind"
        ),
    )
    op.create_index("ix_trash_entries_user_deleted", "trash_entries", ["user_id", "deleted_at"])
    op.create_index("ix_trash_entries_container", "trash_entries", ["container_id"])
    op.create_index("ix_trash_entries_deleted_by", "trash_entries", ["deleted_by"])


def downgrade() -> None:
    op.drop_table("trash_entries")

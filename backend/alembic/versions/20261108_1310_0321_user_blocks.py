"""Blocking people, shared by every app (``app/people/blocks.py``).

Revision ID: 0321_user_blocks
Revises: 0320_push_quiet
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0321_user_blocks"
down_revision = "0320_push_quiet"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_blocks",
        sa.Column("blocker_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("blocked_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("blocker_id <> blocked_id", name="ck_user_blocks_not_self"),
    )
    op.create_index("ix_user_blocks_blocked_id", "user_blocks", ["blocked_id"])


def downgrade() -> None:
    op.drop_index("ix_user_blocks_blocked_id", table_name="user_blocks")
    op.drop_table("user_blocks")

"""Feedback goes to this server's admins; thumbs up/down on replies removed.

* ``feedback_messages``: what someone wrote with the Send feedback button,
  kept on this server for its admins (Admin → Feedback).
* ``messages.feedback`` / ``messages.feedback_reason`` (0052) are dropped:
  the thumbs on AI replies are gone.

Downgrade re-adds the two columns, empty; the ratings aren't kept anywhere.

Revision ID: 0424_feedback_to_admin
Revises: 0423_scrub_audit_details
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0424_feedback_to_admin"
down_revision = "0423_scrub_audit_details"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "feedback_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_feedback_messages_user_id", "feedback_messages", ["user_id"])
    op.create_index("ix_feedback_messages_created_at", "feedback_messages", ["created_at"])
    op.drop_column("messages", "feedback_reason")
    op.drop_column("messages", "feedback")


def downgrade() -> None:
    op.add_column("messages", sa.Column("feedback", sa.String(length=8), nullable=True))
    op.add_column("messages", sa.Column("feedback_reason", sa.Text(), nullable=True))
    op.drop_index("ix_feedback_messages_created_at", table_name="feedback_messages")
    op.drop_index("ix_feedback_messages_user_id", table_name="feedback_messages")
    op.drop_table("feedback_messages")

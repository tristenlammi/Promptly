"""Workspace discussions — threaded messaging between workspace members.

Backs a ``kind='discussion'`` workspace item: threads (topics) each holding a
chronological list of messages. ``workspace_id`` is denormalised onto both
tables so listing + access checks don't need a join back through the item
(same trick ``workspace_item_comments`` uses).

RAG is deliberately OPT-IN: the discussion item is created with
``context_enabled=false`` and nothing is embedded until a member turns it on,
so private team chatter is never vectorised by default.

Revision ID: 0161_discussions
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0161_discussions"
down_revision = "0160_remove_chart_dataview"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discussion_threads",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspace_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # Sort key for "most recent activity first"; seeded at creation.
        sa.Column(
            "last_message_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_discussion_threads_item_id", "discussion_threads", ["item_id"]
    )
    op.create_index(
        "ix_discussion_threads_workspace_id",
        "discussion_threads",
        ["workspace_id"],
    )

    op.create_table(
        "discussion_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "thread_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("discussion_threads.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # SET NULL so deleting a user keeps the conversation readable.
        sa.Column(
            "author_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_discussion_messages_thread_id", "discussion_messages", ["thread_id"]
    )
    op.create_index(
        "ix_discussion_messages_workspace_id",
        "discussion_messages",
        ["workspace_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_discussion_messages_workspace_id", table_name="discussion_messages"
    )
    op.drop_index(
        "ix_discussion_messages_thread_id", table_name="discussion_messages"
    )
    op.drop_table("discussion_messages")
    op.drop_index(
        "ix_discussion_threads_workspace_id", table_name="discussion_threads"
    )
    op.drop_index(
        "ix_discussion_threads_item_id", table_name="discussion_threads"
    )
    op.drop_table("discussion_threads")

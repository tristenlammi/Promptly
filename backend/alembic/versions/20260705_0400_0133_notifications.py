"""Persistent notification inbox.

Until now ``notify_user`` was fire-and-forget web push — nothing to
catch up on if you weren't looking. This table is the durable copy the
in-app inbox reads: mentions, card assignments, workspace invites, and
automation outcomes all land here (push stays as the real-time nudge).

Revision ID: 0133_notifications
Revises: 0132_user_avatars
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0133_notifications"
down_revision: Union[str, Sequence[str], None] = "0132_user_avatars"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Push-preference switches for the three new event kinds. The inbox
    # row is always written — these only gate the push nudge.
    for col in ("mention", "assignment", "invite"):
        op.add_column(
            "push_preferences",
            sa.Column(col, sa.Boolean(), nullable=False, server_default="true"),
        )
    op.create_table(
        "notifications",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # mention | assignment | invite | task_complete | comment | system
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        # In-app deep link ("/workspaces/<id>?item=…"); relative on purpose.
        sa.Column("url", sa.String(length=500), nullable=True),
        # Who triggered it (for the inbox row's avatar). SET NULL so
        # deleting an account doesn't eat its trail of notifications.
        sa.Column(
            "actor_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    # The two hot paths: unread badge count and the newest-first list.
    op.create_index(
        "ix_notifications_user_unread",
        "notifications",
        ["user_id"],
        postgresql_where=sa.text("read_at IS NULL"),
    )
    op.create_index(
        "ix_notifications_user_created",
        "notifications",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_user_created", table_name="notifications")
    op.drop_index("ix_notifications_user_unread", table_name="notifications")
    op.drop_table("notifications")
    for col in ("invite", "assignment", "mention"):
        op.drop_column("push_preferences", col)

"""Drop conversation_shares — per-chat sharing removed.

Per-conversation sharing (inviting another user to a single chat) was
removed from the product: it was little-used and recipients had no way
to drop a shared chat from their list. Project-level sharing
(``project_shares``) remains the single collaboration surface.

This migration drops the ``conversation_shares`` table and its
indexes. ``messages.author_user_id`` is intentionally **kept** — it
still drives "from Jane" author chips on project-shared chats.

Revision ID: 0050_drop_conv_shares
Revises: 0049_msgs_reasoning
Create Date: 2026-05-29 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0050_drop_conv_shares"
down_revision: Union[str, Sequence[str], None] = "0049_msgs_reasoning"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ``IF EXISTS`` keeps the migration idempotent on installs where
    # the table was never created (fresh DBs running the whole chain).
    op.execute("DROP INDEX IF EXISTS ix_conversation_shares_conversation_id")
    op.execute("DROP INDEX IF EXISTS ix_conversation_shares_invitee_status")
    op.execute("DROP TABLE IF EXISTS conversation_shares")


def downgrade() -> None:
    # Recreate the table as it stood in migration 0018 so a downgrade
    # leaves a schema the old code could run against. Rows are not
    # restored (the data is gone).
    op.create_table(
        "conversation_shares",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "inviter_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "invitee_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "conversation_id",
            "invitee_user_id",
            name="uq_conversation_shares_conv_invitee",
        ),
    )
    op.create_index(
        "ix_conversation_shares_invitee_status",
        "conversation_shares",
        ["invitee_user_id", "status"],
    )
    op.create_index(
        "ix_conversation_shares_conversation_id",
        "conversation_shares",
        ["conversation_id"],
    )

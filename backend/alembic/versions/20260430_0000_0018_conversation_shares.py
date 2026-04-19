"""Conversation sharing — invite a friend to collaborate on a chat.

Two changes shipped together so the feature lands as a single,
revertable unit:

* ``conversation_shares`` — one row per (conversation, invitee).
  ``status`` walks ``pending -> accepted`` (invitee accepted) or
  ``pending -> declined`` (invitee dismissed it). Owners can also
  revoke at any time, which deletes the row outright. ``UNIQUE
  (conversation_id, invitee_user_id)`` prevents an owner from
  inviting the same person twice.

* ``messages.author_user_id`` — who actually sent each user
  message. Backfilled from ``conversations.user_id`` so existing
  rows look like the owner sent everything (which they did, before
  sharing existed). Required so the UI can render "from Jane" chips
  on shared chats. Nullable for assistant rows where it stays
  ``NULL``; backfill skips ``role <> 'user'`` rows.

Costs naturally fall on the sender because ``record_usage`` already
keys on the authenticated user that posted the turn — no schema
change needed there.

Revision ID: 0018_conversation_shares
Revises: 0017_message_fts
Create Date: 2026-04-30 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018_conversation_shares"
down_revision: Union[str, Sequence[str], None] = "0017_message_fts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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

    # author_user_id on messages — nullable so assistant/system rows
    # stay NULL. Backfill user-role rows to the conversation owner so
    # legacy chats render correctly under the new "author chip" UI.
    op.add_column(
        "messages",
        sa.Column(
            "author_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.execute(
        """
        UPDATE messages m
        SET    author_user_id = c.user_id
        FROM   conversations c
        WHERE  m.conversation_id = c.id
          AND  m.role = 'user'
          AND  m.author_user_id IS NULL;
        """
    )
    op.create_index(
        "ix_messages_author_user_id",
        "messages",
        ["author_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_messages_author_user_id", table_name="messages")
    op.drop_column("messages", "author_user_id")
    op.drop_index(
        "ix_conversation_shares_conversation_id",
        table_name="conversation_shares",
    )
    op.drop_index(
        "ix_conversation_shares_invitee_status",
        table_name="conversation_shares",
    )
    op.drop_table("conversation_shares")

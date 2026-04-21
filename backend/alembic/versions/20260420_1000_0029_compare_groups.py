"""Side-by-side compare mode — compare_groups table + conversation link.

Compare mode lets the user fan a single prompt out to N (2–4) models
in parallel columns, then "crown" the best response to continue a
real conversation with. Each column is backed by a real
``conversations`` row (so reload / SSE / tool infrastructure all keep
working) grouped by ``compare_group_id``.

The group itself is tracked by a dedicated table — not a JSON blob
on a conversation — so "list my compare sessions", "archive
losers", and the crown handoff can all be plain relational
operations.

Design choices:

* ``crowned_conversation_id`` is nullable until the user picks a
  winner. Before crowning, every column is equal; after crowning,
  the normal sidebar lists the crowned conversation as a regular
  chat while the losers are filtered out (they stay available
  through the Compare archive view).
* ``archived_at`` soft-deletes the group from the main archive list
  once the user is done with it, without losing the rows outright —
  useful if they later want to resurrect a losing column.
* Conversations keep a nullable ``compare_group_id`` FK with
  ``ON DELETE SET NULL`` — deleting the group (hard delete) just
  detaches the conversations so they can live on as stand-alone
  chats if the user wants to keep one manually. The sidebar filters
  non-crowned compare conversations out until the group is decided,
  so a dangling FK never leaks stale rows into the main list.

Revision ID: 0029_compare_groups
Revises: 0028_push_notifications
Create Date: 2026-04-20 10:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0029_compare_groups"
down_revision: Union[str, Sequence[str], None] = "0028_push_notifications"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "compare_groups",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Human-friendly name the UI surfaces in the archive list.
        # Derived from the first prompt if the user doesn't set one.
        sa.Column("title", sa.String(200), nullable=True),
        # The prompt that was fanned out to the columns. Stored
        # directly on the group so the archive view can preview
        # "Compare: what are the trade-offs of …" without having to
        # dereference any column's first message.
        sa.Column("seed_prompt", sa.Text(), nullable=True),
        # Nullable until the user picks a winner. When set, the
        # referenced conversation becomes "just a chat" in the
        # sidebar and the other columns are archived.
        #
        # ``ondelete='SET NULL'`` so deleting the crowned chat
        # doesn't cascade and nuke the whole compare group record —
        # the losers are still useful history.
        sa.Column(
            "crowned_conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "archived_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_compare_groups_user_archived",
        "compare_groups",
        ["user_id", "archived_at"],
    )

    # Link existing conversations into compare groups. Nullable so
    # it's a no-op for every pre-existing chat.
    op.add_column(
        "conversations",
        sa.Column(
            "compare_group_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("compare_groups.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_conversations_compare_group",
        "conversations",
        ["compare_group_id"],
        postgresql_where=sa.text("compare_group_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_compare_group", table_name="conversations")
    op.drop_column("conversations", "compare_group_id")
    op.drop_index("ix_compare_groups_user_archived", table_name="compare_groups")
    op.drop_table("compare_groups")

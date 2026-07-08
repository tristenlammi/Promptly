"""Conversation visibility for workspace chats.

Adds ``conversations.visibility`` ("private" | "workspace"). New workspace
chats default to private (creator-only) so they aren't exposed to the whole
team until the creator shares them; existing rows also default to private
(the previous "every member could open every workspace chat" behaviour was
the bug we're fixing). Personal chats ignore it.

Revision ID: 0151_conv_visibility
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0151_conv_visibility"
down_revision = "0150_rosters"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "visibility",
            sa.String(length=16),
            nullable=False,
            server_default="private",
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "visibility")

"""Opt-in chat-as-workspace-context.

Adds the columns that let a workspace chat feed its transcript into the
workspace RAG pool:

* ``conversations.context_enabled``       — opt-in flag (default false).
* ``conversations.context_file_id``       — backing Drive file holding the
  flattened transcript (FK ``files.id`` ON DELETE SET NULL).
* ``conversations.context_index_status``  — queued/embedding/ready/failed.
* ``conversations.context_indexed_hash``  — content hash for re-embed skip.

Revision ID: 0090_chat_workspace_context
Revises: 0089_workspace_item_pinned
Create Date: 2026-06-19 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0090_chat_workspace_context"
down_revision: Union[str, Sequence[str], None] = "0089_workspace_item_pinned"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "context_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "context_file_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
    )
    op.add_column(
        "conversations",
        sa.Column("context_index_status", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("context_indexed_hash", sa.String(length=64), nullable=True),
    )
    op.create_foreign_key(
        "fk_conversations_context_file_id_files",
        "conversations",
        "files",
        ["context_file_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_conversations_context_file_id_files",
        "conversations",
        type_="foreignkey",
    )
    op.drop_column("conversations", "context_indexed_hash")
    op.drop_column("conversations", "context_index_status")
    op.drop_column("conversations", "context_file_id")
    op.drop_column("conversations", "context_enabled")

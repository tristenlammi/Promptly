"""Pin workspace items to the rail's Pinned section.

Adds ``workspace_items.pinned`` (default false). Chats reuse the existing
``conversations.pinned`` column, so this only covers stored items
(notes / canvases / folders).

Revision ID: 0089_workspace_item_pinned
Revises: 0088_workspace_context_toggle
Create Date: 2026-06-16 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0089_workspace_item_pinned"
down_revision: Union[str, Sequence[str], None] = "0088_workspace_context_toggle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_items",
        sa.Column(
            "pinned",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("workspace_items", "pinned")

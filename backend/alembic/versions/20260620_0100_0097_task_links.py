"""Card → workspace-item links.

Adds ``links`` to ``workspace_tasks`` — a JSON list of references to other
navigator items (notes / canvases / chats / boards) a card relates to. Each
entry is ``{item_id, kind, ref_id, title}``; the title is denormalised so the
board's RAG text and a freshly-loaded card render without a tree lookup.

Revision ID: 0097_task_links
Revises: 0096_task_comments
Create Date: 2026-06-20 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0097_task_links"
down_revision: Union[str, Sequence[str], None] = "0096_task_comments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_tasks",
        sa.Column("links", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_tasks", "links")

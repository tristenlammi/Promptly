"""Per-item "use as workspace context" toggle.

Adds ``context_enabled`` (default true) to ``workspace_items`` and
``workspace_files``. When false, the note/canvas/file stays in the
workspace but is filtered out of the shared RAG injection — letting users
keep drafts/scratch/sensitive items out of the AI's context while the
default stays the zero-ritual "everything is context".

Revision ID: 0088_workspace_context_toggle
Revises: 0087_workspace_tasks
Create Date: 2026-06-16 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0088_workspace_context_toggle"
down_revision: Union[str, Sequence[str], None] = "0087_workspace_tasks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_items",
        sa.Column(
            "context_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.add_column(
        "workspace_files",
        sa.Column(
            "context_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("workspace_files", "context_enabled")
    op.drop_column("workspace_items", "context_enabled")

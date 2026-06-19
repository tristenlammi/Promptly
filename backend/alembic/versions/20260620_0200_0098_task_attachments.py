"""Card file attachments + cover.

Adds ``attachments`` to ``workspace_tasks`` — a JSON list of
``{file_id, filename, mime_type, size_bytes, is_cover}`` referencing
``UserFile`` rows. Attachment text is embedded into the workspace RAG pool;
an image flagged ``is_cover`` renders on the card face.

Revision ID: 0098_task_attachments
Revises: 0097_task_links
Create Date: 2026-06-20 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0098_task_attachments"
down_revision: Union[str, Sequence[str], None] = "0097_task_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspace_tasks",
        sa.Column("attachments", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspace_tasks", "attachments")

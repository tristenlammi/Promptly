"""Chart pages: charts table.

The backing entity for a ``kind='chart'`` workspace item — mirrors the
``rosters``/``spreadsheets`` tables. ``data`` holds the whole chart (type +
rows + column config); ``content_text`` + ``text_file_id`` carry a flattened
text table into ``knowledge_chunks`` so a chat can answer questions about the
numbers.

Revision ID: 0154_charts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0154_charts"
# Chained after 0153_search_provider_backoff (a concurrent migration that also
# branched off 0152) to keep a single linear head — not off 0152 directly.
down_revision = "0153_search_provider_backoff"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "charts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "title",
            sa.String(length=255),
            nullable=False,
            server_default="Untitled chart",
        ),
        sa.Column("data", postgresql.JSONB(), nullable=True),
        sa.Column("content_text", sa.Text(), nullable=True),
        sa.Column(
            "text_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_charts_workspace_id", "charts", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_charts_workspace_id", table_name="charts")
    op.drop_table("charts")

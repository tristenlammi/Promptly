"""Roster pages: rosters table.

The backing entity for a ``kind='roster'`` workspace item — mirrors the
``spreadsheets`` table. ``data`` holds the whole schedule (shifts + settings);
``content_text`` + ``text_file_id`` carry a flattened version into
``knowledge_chunks`` so a chat can answer "who's on Friday?".

Revision ID: 0150_rosters
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0150_rosters"
down_revision = "0149_drop_ws_folders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rosters",
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
            server_default="Untitled roster",
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
    op.create_index("ix_rosters_workspace_id", "rosters", ["workspace_id"])


def downgrade() -> None:
    op.drop_index("ix_rosters_workspace_id", table_name="rosters")
    op.drop_table("rosters")

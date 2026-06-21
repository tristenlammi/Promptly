"""Spreadsheet pages: spreadsheets table.

Backing entity for a ``document_pages`` row of ``kind='sheet'`` — the
spreadsheet analogue of ``workspace_canvas``. Phase 2 persists the
Fortune-sheet workbook JSON in ``data`` (single-user, debounced save);
``content_text`` + ``text_file_id`` carry the flattened text into the
workspace RAG pool the same way a canvas does. No backfill — sheets are a
new, opt-in page kind.

Revision ID: 0100_spreadsheets
Revises: 0099_document_pages
Create Date: 2026-06-21 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0100_spreadsheets"
down_revision: Union[str, Sequence[str], None] = "0099_document_pages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "spreadsheets",
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
            server_default="Untitled spreadsheet",
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
    op.create_index(
        "ix_spreadsheets_workspace_id", "spreadsheets", ["workspace_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_spreadsheets_workspace_id", table_name="spreadsheets")
    op.drop_table("spreadsheets")

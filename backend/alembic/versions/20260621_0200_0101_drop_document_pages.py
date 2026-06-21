"""Drop document_pages.

The multi-page-document model (a note with richtext/sheet *pages*) was
superseded by the generic Notebook container, whose pages are first-class
child workspace items. The ``document_pages`` table and all code that read it
are removed; spreadsheets remain (their own ``spreadsheets`` table, now backing
``kind='sheet'`` items rather than note pages).

Revision ID: 0101_drop_document_pages
Revises: 0100_spreadsheets
Create Date: 2026-06-21 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0101_drop_document_pages"
down_revision: Union[str, Sequence[str], None] = "0100_spreadsheets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ix_document_pages_ref_id", table_name="document_pages")
    op.drop_index("ix_document_pages_item_id", table_name="document_pages")
    op.drop_table("document_pages")


def downgrade() -> None:
    # Recreate the table shape (no data backfill on downgrade).
    op.create_table(
        "document_pages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspace_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default="richtext",
        ),
        sa.Column("ref_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column(
            "position", sa.Float(), nullable=False, server_default="0"
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
        "ix_document_pages_item_id", "document_pages", ["item_id"]
    )
    op.create_index(
        "ix_document_pages_ref_id", "document_pages", ["ref_id"]
    )

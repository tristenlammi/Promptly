"""Multi-page documents: document_pages table.

A workspace note becomes a multi-page document. Each page is a row here,
ordered by float ``position`` within its owning ``workspace_items`` row.
``kind`` selects the surface ('richtext' today, 'sheet' later); ``ref_id``
is the backing entity (a ``files.id`` for a richtext page). Existing notes
are backfilled to a single richtext page pointing at their current document,
so every single-page code path keeps working unchanged.

Revision ID: 0099_document_pages
Revises: 0098_task_attachments
Create Date: 2026-06-21 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0099_document_pages"
down_revision: Union[str, Sequence[str], None] = "0098_task_attachments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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

    # Backfill: every existing note → one richtext page pointing at its
    # current backing document, so single-page notes become one-page docs
    # with zero content movement. ``gen_random_uuid()`` is core in PG 13+.
    op.execute(
        """
        INSERT INTO document_pages
            (id, item_id, kind, ref_id, title, position, created_at, updated_at)
        SELECT
            gen_random_uuid(), wi.id, 'richtext', wi.ref_id,
            COALESCE(NULLIF(wi.title, ''), 'Page 1'), 0, now(), now()
        FROM workspace_items wi
        WHERE wi.kind = 'note' AND wi.ref_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_document_pages_ref_id", table_name="document_pages")
    op.drop_index("ix_document_pages_item_id", table_name="document_pages")
    op.drop_table("document_pages")

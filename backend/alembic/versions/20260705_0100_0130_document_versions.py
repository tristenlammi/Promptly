"""Document version history (Phase 9).

``document_versions`` stores point-in-time HTML snapshots of Drive
Documents (notes). Captured on the collab snapshot path (throttled +
deduped) and on explicit manual saves; restore is a client-side
``setContent`` that flows back through Yjs, so this table only stores
and serves versions.

Revision ID: 0130_document_versions
Revises: 0129_ws_drive_quota
Create Date: 2026-07-05 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0130_document_versions"
down_revision: Union[str, Sequence[str], None] = "0129_ws_drive_quota"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "document_versions",
        sa.Column(
            "id",
            sa.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("file_id", sa.UUID(as_uuid=True), nullable=False),
        sa.Column("html", sa.Text(), nullable=False),
        sa.Column("plain_text", sa.Text(), nullable=True),
        sa.Column(
            "size_bytes", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("author_user_id", sa.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "source",
            sa.String(length=16),
            nullable=False,
            server_default="auto",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["file_id"], ["files.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["author_user_id"], ["users.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "ix_document_versions_file_id", "document_versions", ["file_id"]
    )
    op.create_index(
        "ix_document_versions_created_at",
        "document_versions",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_document_versions_created_at", table_name="document_versions"
    )
    op.drop_index(
        "ix_document_versions_file_id", table_name="document_versions"
    )
    op.drop_table("document_versions")

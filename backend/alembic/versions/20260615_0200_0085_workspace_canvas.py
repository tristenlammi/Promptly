"""Workspace canvases — multiplayer tldraw boards (Phase 2).

Adds ``workspace_canvas``: one row per tldraw board in a workspace. The
board's tldraw store syncs over the same Yjs/Hocuspocus substrate as
documents, persisted here as a CRDT update (``yjs_update`` + monotonic
``version``, mirroring ``document_state``). ``content_text`` carries the
client-flattened shape text for RAG; ``text_file_id`` points at the
backing Drive text file that actually feeds ``knowledge_chunks``.

Greenfield: no existing canvases to backfill.

Revision ID: 0085_workspace_canvas
Revises: 0084_workspace_items
Create Date: 2026-06-15 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0085_workspace_canvas"
down_revision: Union[str, Sequence[str], None] = "0084_workspace_items"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspace_canvas",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        # Full merged Y.Doc (tldraw store). Seeded empty at creation.
        sa.Column("yjs_update", sa.LargeBinary(), nullable=False),
        sa.Column(
            "version", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.Column("content_text", sa.Text(), nullable=True),
        # Backing Drive text file (in Canvases/) for RAG. SET NULL so a
        # Drive-side delete of the text file doesn't drop the canvas.
        sa.Column(
            "text_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_workspace_canvas_workspace", "workspace_canvas", ["workspace_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workspace_canvas_workspace", table_name="workspace_canvas"
    )
    op.drop_table("workspace_canvas")

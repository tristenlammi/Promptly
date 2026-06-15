"""Workspace navigator tree + Drive root folder (Phase 1a).

Adds the two pieces the workspace navigator needs:

* ``workspace_items`` — the unified, nestable, reorderable tree that is
  the source of truth for the left-rail navigator. Holds ``folder`` and
  ``note`` rows today (``canvas`` / ``file`` in later phases); chats are
  synthesised at read time and never stored here.
* ``workspaces.root_folder_id`` — FK to the auto-created
  ``My files / Workspaces / <title>`` Drive folder where the workspace's
  notes / canvases / uploaded files physically live.

No data backfill: the Phase-0 reset emptied ``workspaces``, so there are
no existing rows whose ``root_folder_id`` we'd have to populate.

Revision ID: 0084_workspace_items
Revises: 0083_workspaces_rename
Create Date: 2026-06-15 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0084_workspace_items"
down_revision: Union[str, Sequence[str], None] = "0083_workspaces_rename"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- workspaces.root_folder_id ----------------------------------
    op.add_column(
        "workspaces",
        sa.Column(
            "root_folder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("file_folders.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # --- workspace_items --------------------------------------------
    op.create_table(
        "workspace_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Self-FK for folder nesting. CASCADE so deleting a folder row
        # drops its subtree (the router trashes backing blobs first).
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspace_items.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        # Polymorphic backing-entity id (-> files.id for a note). Not a
        # FK on purpose — it spans target tables across phases.
        sa.Column("ref_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("icon", sa.String(length=64), nullable=True),
        # Float so a drag inserts between neighbours by midpoint.
        sa.Column(
            "position", sa.Float(), nullable=False, server_default="0"
        ),
        # Inline RAG index lifecycle (note/canvas/file kinds; NULL on folders).
        sa.Column("indexing_status", sa.String(length=16), nullable=True),
        sa.Column("indexing_error", sa.Text(), nullable=True),
        sa.Column("indexed_content_hash", sa.String(length=64), nullable=True),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
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
        "ix_workspace_items_workspace", "workspace_items", ["workspace_id"]
    )
    op.create_index(
        "ix_workspace_items_parent", "workspace_items", ["parent_id"]
    )
    op.create_index(
        "ix_workspace_items_ref", "workspace_items", ["ref_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_workspace_items_ref", table_name="workspace_items")
    op.drop_index("ix_workspace_items_parent", table_name="workspace_items")
    op.drop_index("ix_workspace_items_workspace", table_name="workspace_items")
    op.drop_table("workspace_items")
    op.drop_column("workspaces", "root_folder_id")

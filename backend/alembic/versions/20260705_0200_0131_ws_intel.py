"""Workspace backend-intelligence columns (Phase 10).

Adds four nullable columns to ``workspaces``:

* ``automations_text_file_id`` — backing Drive file for the flattened
  automations RAG index (automations aren't ``workspace_items`` rows, so
  there's no ``ref_id`` to hang it on).
* ``memory_last_status`` / ``memory_last_error`` / ``memory_last_attempt_at``
  — the outcome of the most recent workspace-memory regeneration, so the
  overview Memory card can surface a failed refresh instead of silently
  showing a stale timestamp.

All nullable / no backfill — existing rows read as "never attempted".

Revision ID: 0131_ws_intel
Revises: 0130_document_versions
Create Date: 2026-07-05 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0131_ws_intel"
down_revision: Union[str, Sequence[str], None] = "0130_document_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "automations_text_file_id", sa.UUID(as_uuid=True), nullable=True
        ),
    )
    op.create_foreign_key(
        "fk_workspaces_automations_text_file_id",
        "workspaces",
        "files",
        ["automations_text_file_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "workspaces",
        sa.Column("memory_last_status", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "workspaces",
        sa.Column("memory_last_error", sa.Text(), nullable=True),
    )
    op.add_column(
        "workspaces",
        sa.Column(
            "memory_last_attempt_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "memory_last_attempt_at")
    op.drop_column("workspaces", "memory_last_error")
    op.drop_column("workspaces", "memory_last_status")
    op.drop_constraint(
        "fk_workspaces_automations_text_file_id",
        "workspaces",
        type_="foreignkey",
    )
    op.drop_column("workspaces", "automations_text_file_id")

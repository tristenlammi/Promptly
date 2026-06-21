"""Workspace memory model: dedicated model for the memory librarian.

Adds ``memory_model_id`` + ``memory_provider_id`` to ``workspaces`` so the
creator can pick which model maintains the workspace memory (any enabled API
model or a local Ollama model), independent of which chat triggered a refresh.
NULL falls back to the workspace default chat model, then the triggering
conversation's model.

Revision ID: 0102_workspace_memory_model
Revises: 0101_drop_document_pages
Create Date: 2026-06-21 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0102_workspace_memory_model"
down_revision: Union[str, Sequence[str], None] = "0101_drop_document_pages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("memory_model_id", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "workspaces",
        sa.Column(
            "memory_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "memory_provider_id")
    op.drop_column("workspaces", "memory_model_id")

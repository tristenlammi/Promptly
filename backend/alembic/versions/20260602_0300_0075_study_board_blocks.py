"""study_board_blocks — Phase 3 evolving lesson board.

Creates ``study_board_blocks``, the persistent canvas that accumulates
lesson artefacts (terms, worked examples, concept nodes, callouts) as the
tutor emits ``<board_op>`` side-channel actions during a unit session.

Each block has an ``order_index`` managed by the service (monotonically
increasing per-session counter) and a ``payload_json`` JSONB bag whose
shape depends on the ``kind`` discriminator.

Revision ID: 0075_study_board_blocks
Revises: 0074_session_phase
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0075_study_board_blocks"
down_revision = "0074_session_phase"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "study_board_blocks",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("order_index", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column(
            "payload_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_study_board_blocks_session_id",
        "study_board_blocks",
        ["session_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_study_board_blocks_session_id", table_name="study_board_blocks")
    op.drop_table("study_board_blocks")

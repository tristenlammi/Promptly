"""Meeting notes from a recording (S-tier 4.4).

``meeting_jobs`` — one row per uploaded meeting recording. The upload
endpoint creates it ``pending`` and enqueues a durable Arq job; the
worker walks it through ``transcribing`` (chunked Whisper passes, with
per-chunk progress commits so the UI can poll) → ``summarising`` (one
model call) → ``done`` (a seeded workspace note) or ``failed``. The
transcript is kept on the row so a summarise-stage failure never throws
away a long transcription.

Revision ID: 0137_meetings
Revises: 0136_webhooks
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0137_meetings"
down_revision: Union[str, Sequence[str], None] = "0136_webhooks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meeting_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column(
            "status", sa.String(length=20), nullable=False, server_default="pending"
        ),
        sa.Column("progress_done", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("progress_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duration_s", sa.Integer(), nullable=True),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("audio_path", sa.String(length=500), nullable=True),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("note_item_id", sa.Uuid(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["note_item_id"], ["workspace_items.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_meeting_jobs_workspace_id", "meeting_jobs", ["workspace_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_meeting_jobs_workspace_id", table_name="meeting_jobs")
    op.drop_table("meeting_jobs")

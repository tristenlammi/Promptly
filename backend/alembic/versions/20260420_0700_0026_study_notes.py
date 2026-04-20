"""Replace Excalidraw whiteboard with plain-text per-unit notes.

The Excalidraw freehand canvas was rarely used, cost ~1 MB of bundle,
and the AI tutor couldn't read user drawings anyway. Swap it for a
lightweight markdown-ish notes pad attached to the same (1:1 with
unit) session:

* ``study_sessions.excalidraw_snapshot`` (JSONB) → ``study_sessions.notes_md`` (TEXT)
* ``whiteboard_exercises.excalidraw_snap`` (TEXT, base64 PNG of the
  drawing at submit time) → dropped entirely. The AI grader never
  actually consumed this; it only ever looked at the structured
  ``answer_payload``.

We ADD the new column before dropping the old one so a failed
migration leaves the old data intact.

Revision ID: 0026_study_notes
Revises: 0025_calibration_source
Create Date: 2026-04-20 07:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0026_study_notes"
down_revision: Union[str, Sequence[str], None] = "0025_calibration_source"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "study_sessions",
        sa.Column("notes_md", sa.Text(), nullable=True),
    )
    op.drop_column("study_sessions", "excalidraw_snapshot")
    op.drop_column("whiteboard_exercises", "excalidraw_snap")


def downgrade() -> None:
    op.add_column(
        "whiteboard_exercises",
        sa.Column("excalidraw_snap", sa.Text(), nullable=True),
    )
    op.add_column(
        "study_sessions",
        sa.Column(
            "excalidraw_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.drop_column("study_sessions", "notes_md")

"""Study unit reflections — collapse duplicates and enforce uniqueness.

The ``study_unit_reflections`` table was always intended to hold at most
one row per ``(unit_id, session_id)`` pair (re-emitting the
``summarise_unit`` action within a session is supposed to *update* the
existing row), but the original migration never added a UNIQUE
constraint to enforce that invariant. As a result, sessions that had
``mark_complete`` rejected and the tutor retried (re-emitting
``summarise_unit`` along the way) ended up with duplicate rows.

The handler then crashed on the next invocation because it used
``scalar_one_or_none()``, which raises ``MultipleResultsFound`` when
the result set is bigger than 1. That exception bubbled up through the
SSE stream generator and the browser saw
``ERR_INCOMPLETE_CHUNKED_ENCODING`` — surfaced to the user as a
meaningless "Network Error" toast.

This migration:

1. Collapses duplicate rows in place: keep the most recently created
   row per ``(unit_id, session_id)`` group, drop the rest.
2. Adds the UNIQUE constraint so duplicates can never be inserted
   again. The application code is also being updated to be tolerant of
   any pre-existing duplicates as a belt-and-braces safeguard.

NULL ``session_id`` values are intentionally NOT collapsed — Postgres
treats NULL as distinct under UNIQUE by default, which matches the
semantics we want here (a reflection that lost its session linkage is
already an orphan; we don't want to merge orphans across different
units' sessions).

Revision ID: 0039_unit_reflection_unique
Revises: 0038_document_state
Create Date: 2026-04-27 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0039_unit_reflection_unique"
down_revision: Union[str, None] = "0038_document_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Step 1 — Drop duplicate rows, keeping the latest by ``created_at``
    # (and tie-breaking on ``id`` so the result is deterministic). We
    # only deduplicate rows where ``session_id`` is NOT NULL because
    # NULL is the "orphaned" case and Postgres' UNIQUE semantics already
    # treat NULLs as distinct.
    op.execute(
        """
        DELETE FROM study_unit_reflections a
        USING study_unit_reflections b
        WHERE a.unit_id = b.unit_id
          AND a.session_id = b.session_id
          AND a.session_id IS NOT NULL
          AND (a.created_at, a.id) < (b.created_at, b.id);
        """
    )

    # Step 2 — Enforce the invariant going forward. Partial UNIQUE index
    # so the constraint only applies when ``session_id`` is set.
    op.create_index(
        "ix_study_unit_reflections_unit_session_uq",
        "study_unit_reflections",
        ["unit_id", "session_id"],
        unique=True,
        postgresql_where=sa.text("session_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_study_unit_reflections_unit_session_uq",
        table_name="study_unit_reflections",
    )

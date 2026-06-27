"""Heal a drifted study_retrieval_attempts.tutor_score column.

Migration 0073 creates ``study_retrieval_attempts`` WITH a
``tutor_score`` column, and the ORM model expects it. But some
environments ended up with the table missing that column (0073 was
applied before ``tutor_score`` was added to the migration/model, leaving
the DB stuck at head with no way to pick the column up). Any query that
selects from ``study_retrieval_attempts`` then 500s with
``UndefinedColumnError: column ... tutor_score does not exist`` — which
breaks the assessor, mastery derivation, and the calibration history
endpoint.

This adds the column idempotently: ``ADD COLUMN IF NOT EXISTS`` is a
no-op on a clean DB (where 0073 already created it) and self-heals any
drifted DB. Mirrors the 0073 definition exactly
(``sa.Integer(), nullable=True``).

Revision ID: 0116_retrieval_tutor_score
Revises: 0115_task_connectors
Create Date: 2026-06-27 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0116_retrieval_tutor_score"
down_revision: Union[str, Sequence[str], None] = "0115_task_connectors"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE study_retrieval_attempts "
        "ADD COLUMN IF NOT EXISTS tutor_score INTEGER"
    )


def downgrade() -> None:
    # Non-destructive heal — leave the column in place on downgrade so we
    # don't drop data on environments where it legitimately belongs (0073).
    pass

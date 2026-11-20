"""Study, phase 3: figures and code, and courses given to family.

* ``study_concepts.tool`` — what the concept suits beyond words: a figure to
  play with (``plot``, ``scale``, ``parts``, ``table``) or ``code`` to write.
  Empty for most.
* ``study_subjects.code_lang`` — the programming language a subject teaches,
  when it is a programming subject the app can run (``javascript``).
* ``study_subjects.shared_from`` — the name of whoever gave this course, on
  the receiver's own copy. A copy carries the course, never the giver's
  progress.

Revision ID: 0485_study_three
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0485_study_three"
down_revision = "0484_study_two"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("study_concepts", sa.Column("tool", sa.String(8), nullable=False, server_default=""))
    op.add_column("study_subjects", sa.Column("code_lang", sa.String(16), nullable=True))
    op.add_column("study_subjects", sa.Column("shared_from", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("study_subjects", "shared_from")
    op.drop_column("study_subjects", "code_lang")
    op.drop_column("study_concepts", "tool")

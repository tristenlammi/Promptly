"""Team Learning (Study L2): material-gap inbox.

``study_material_gaps`` — questions the course materials couldn't
answer, flagged by the tutor on assigned-course sessions so the lead
can improve the docs.

Revision ID: 0143_material_gaps
Revises: 0142_study_courses
Create Date: 2026-07-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0143_material_gaps"
down_revision: Union[str, Sequence[str], None] = "0142_study_courses"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "study_material_gaps",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=True),
        sa.Column("unit_title", sa.String(length=255), nullable=True),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="open"
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["course_id"], ["study_courses.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["study_projects.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_study_material_gaps_course_id", "study_material_gaps", ["course_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_study_material_gaps_course_id", table_name="study_material_gaps"
    )
    op.drop_table("study_material_gaps")

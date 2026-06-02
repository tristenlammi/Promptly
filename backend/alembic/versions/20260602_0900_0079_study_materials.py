"""study_materials table

Revision ID: 0079_study_materials
Revises: 0078_nullable_session_id_attempts
Create Date: 2026-06-02 09:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0079_study_materials"
down_revision = "0078_nullable_session_id_attempts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "study_materials",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "study_project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "indexing_status",
            sa.String(16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("indexing_error", sa.Text(), nullable=True),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_study_materials_study_project_id",
        "study_materials",
        ["study_project_id"],
    )
    op.create_index(
        "ix_study_materials_user_file_id",
        "study_materials",
        ["user_file_id"],
    )
    op.create_unique_constraint(
        "uq_study_materials_project_file",
        "study_materials",
        ["study_project_id", "user_file_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_study_materials_project_file", "study_materials", type_="unique")
    op.drop_index("ix_study_materials_user_file_id", table_name="study_materials")
    op.drop_index("ix_study_materials_study_project_id", table_name="study_materials")
    op.drop_table("study_materials")

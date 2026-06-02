"""Add study_project_id scope to knowledge_chunks

Revision ID: 0080_study_project_chunks
Revises: 0079_study_materials
Create Date: 2026-06-02 09:10:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0080_study_project_chunks"
down_revision = "0079_study_materials"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the two-scope CHECK constraint (custom_model OR project).
    op.drop_constraint("ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check")

    # Add the new study_project_id column.
    op.add_column(
        "knowledge_chunks",
        sa.Column(
            "study_project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("study_projects.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_knowledge_chunks_study_project_id",
        "knowledge_chunks",
        ["study_project_id"],
    )

    # Restore the constraint extended to three scopes — still exactly one set.
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (project_id IS NOT NULL)::int"
        " + (study_project_id IS NOT NULL)::int) = 1",
    )

    # Partial unique index to prevent duplicate chunk ingestion per study project.
    op.execute(
        "CREATE UNIQUE INDEX uq_knowledge_chunks_study_chunk"
        " ON knowledge_chunks (study_project_id, user_file_id, chunk_index)"
        " WHERE study_project_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_knowledge_chunks_study_chunk")
    op.drop_constraint("ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check")
    op.drop_index("ix_knowledge_chunks_study_project_id", table_name="knowledge_chunks")
    op.drop_column("knowledge_chunks", "study_project_id")
    # Restore the original two-scope constraint.
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int + (project_id IS NOT NULL)::int) = 1",
    )

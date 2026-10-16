"""Moving in: import jobs (WP-10.1, Part C §4.9).

``import_jobs``: one per import (a Google Takeout, a folder of photos, an
Apple export) — its uploaded archive parts, where it's got to, the dry-run
report and the progress of the run.

``file_import_meta``: what an import said about a file that the file itself
doesn't — Takeout keeps the date taken, the place and the description in a
JSON beside each photo. The media worker reads the file first and falls
back to these.

Revision ID: 0210_import_jobs
Revises: 0209_album_links
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0210_import_jobs"
down_revision = "0209_album_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "import_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="collecting"),
        sa.Column("parts", postgresql.JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("report", postgresql.JSONB, nullable=True),
        sa.Column("progress", postgresql.JSONB, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("source IN ('takeout', 'folder', 'apple')", name="ck_import_jobs_source"),
        sa.CheckConstraint(
            "state IN ('collecting', 'indexing', 'ready', 'importing', 'done', 'failed', 'cancelled')",
            name="ck_import_jobs_state",
        ),
    )
    op.create_index("ix_import_jobs_user", "import_jobs", ["user_id", "created_at"])
    op.create_table(
        "file_import_meta",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lat", sa.Float, nullable=True),
        sa.Column("lon", sa.Float, nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("job_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("import_jobs.id", ondelete="SET NULL"), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("file_import_meta")
    op.drop_index("ix_import_jobs_user", table_name="import_jobs")
    op.drop_table("import_jobs")

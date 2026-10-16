"""Content-modified time on files; trashed folders don't block names (R-209).

``files.updated_at`` is bumped by a trigger on every UPDATE, so starring or
moving a file changed its "Modified" date and reordered Recent.
``modified_at`` changes only when the content does.

The folder-name unique index included trashed folders: a name you could no
longer see blocked creating a folder with it. It now covers live folders
only; restore resolves a clash with " (1)".

Trigram indexes on file and folder names back Drive search's partial and
typo-tolerant name matching (R-213).

Revision ID: 0188_files_modified_trash
Revises: 0187_conv_import_source_key
"""
from alembic import op
import sqlalchemy as sa

revision = "0188_files_modified_trash"
down_revision = "0187_conv_import_source_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "files",
        sa.Column("modified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE files SET modified_at = updated_at")
    op.alter_column("files", "modified_at", nullable=False, server_default=sa.text("now()"))
    op.create_index(
        "ix_files_user_modified_at", "files", ["user_id", sa.text("modified_at DESC")]
    )
    op.execute("DROP INDEX IF EXISTS uq_file_folders_user_parent_name")
    op.execute(
        """
        CREATE UNIQUE INDEX uq_file_folders_user_parent_name ON file_folders
            (COALESCE(user_id::text, '_shared_'), COALESCE(parent_id::text, '_root_'), name)
        WHERE trashed_at IS NULL
        """
    )
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_files_filename_trgm ON files "
        "USING gin (lower(filename) gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_file_folders_name_trgm ON file_folders "
        "USING gin (lower(name) gin_trgm_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_file_folders_name_trgm")
    op.execute("DROP INDEX IF EXISTS ix_files_filename_trgm")
    op.execute("DROP INDEX IF EXISTS uq_file_folders_user_parent_name")
    op.execute(
        """
        CREATE UNIQUE INDEX uq_file_folders_user_parent_name ON file_folders
            (COALESCE(user_id::text, '_shared_'), COALESCE(parent_id::text, '_root_'), name)
        """
    )
    op.drop_index("ix_files_user_modified_at", table_name="files")
    op.drop_column("files", "modified_at")

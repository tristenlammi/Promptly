"""Files — trash, starred, and updated_at columns.

Promptly Drive stage 1 schema. Adds three additive columns to both
``files`` and ``file_folders``:

- ``trashed_at`` — nullable timestamp that flips a row into the Trash
  view. All existing delete paths are being rewired to set this
  instead of hard-deleting; real blob deletion happens when the user
  (or a 30-day sweep) empties the trash.
- ``starred_at`` — nullable timestamp for the Starred view.
- ``updated_at`` — non-null timestamp, defaults to ``now()`` and is
  bumped on every UPDATE via the ``set_updated_at`` trigger. Drives
  the Recent view and enables fresh mtime reporting.

All three columns are nullable / defaulted so existing rows backfill
silently. Partial indexes on ``trashed_at`` and ``(user_id,
starred_at)`` keep the list views fast once we start filtering.

Revision ID: 0035_files_trash_starred
Revises: 0034_study_review_focus
Create Date: 2026-04-25 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0035_files_trash_starred"
down_revision: Union[str, Sequence[str], None] = "0034_study_review_focus"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# One shared trigger function so both tables share the same maintenance
# behaviour. Defined IF NOT EXISTS so repeat-runs after a partial
# downgrade don't explode.
_TRIGGER_FN_UP = """
CREATE OR REPLACE FUNCTION files_set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

_TRIGGER_FN_DOWN = "DROP FUNCTION IF EXISTS files_set_updated_at();"


def upgrade() -> None:
    # --- files --------------------------------------------------------
    op.add_column(
        "files",
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "files",
        sa.Column("starred_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "files",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # --- file_folders -------------------------------------------------
    op.add_column(
        "file_folders",
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "file_folders",
        sa.Column("starred_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "file_folders",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # --- trigger for updated_at ---------------------------------------
    op.execute(_TRIGGER_FN_UP)
    op.execute(
        """
        CREATE TRIGGER files_updated_at_trg
        BEFORE UPDATE ON files
        FOR EACH ROW EXECUTE FUNCTION files_set_updated_at();
        """
    )
    op.execute(
        """
        CREATE TRIGGER file_folders_updated_at_trg
        BEFORE UPDATE ON file_folders
        FOR EACH ROW EXECUTE FUNCTION files_set_updated_at();
        """
    )

    # --- partial indexes ----------------------------------------------
    # Partial indexes (WHERE ... IS NOT NULL) keep the b-tree tiny
    # because the overwhelming majority of rows will never be trashed
    # or starred. The Trash / Starred list queries will still use the
    # index because we phrase them as ``WHERE trashed_at IS NOT NULL``.
    op.execute(
        """
        CREATE INDEX ix_files_trashed_at
        ON files (trashed_at)
        WHERE trashed_at IS NOT NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX ix_files_user_starred_at
        ON files (user_id, starred_at)
        WHERE starred_at IS NOT NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX ix_files_user_updated_at
        ON files (user_id, updated_at DESC);
        """
    )
    op.execute(
        """
        CREATE INDEX ix_file_folders_trashed_at
        ON file_folders (trashed_at)
        WHERE trashed_at IS NOT NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX ix_file_folders_user_starred_at
        ON file_folders (user_id, starred_at)
        WHERE starred_at IS NOT NULL;
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_file_folders_user_starred_at;")
    op.execute("DROP INDEX IF EXISTS ix_file_folders_trashed_at;")
    op.execute("DROP INDEX IF EXISTS ix_files_user_updated_at;")
    op.execute("DROP INDEX IF EXISTS ix_files_user_starred_at;")
    op.execute("DROP INDEX IF EXISTS ix_files_trashed_at;")

    op.execute("DROP TRIGGER IF EXISTS file_folders_updated_at_trg ON file_folders;")
    op.execute("DROP TRIGGER IF EXISTS files_updated_at_trg ON files;")
    op.execute(_TRIGGER_FN_DOWN)

    op.drop_column("file_folders", "updated_at")
    op.drop_column("file_folders", "starred_at")
    op.drop_column("file_folders", "trashed_at")
    op.drop_column("files", "updated_at")
    op.drop_column("files", "starred_at")
    op.drop_column("files", "trashed_at")

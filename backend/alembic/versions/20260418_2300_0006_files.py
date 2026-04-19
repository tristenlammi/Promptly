"""Files feature: per-user + admin-shared folders/files and message attachments.

Two new tables:

  file_folders
    - id, user_id (nullable = admin-shared pool), parent_id (tree), name.
  files
    - id, user_id (nullable = admin-shared pool), folder_id (root when null),
      filename (display), original_filename, mime_type, size_bytes,
      storage_path (relative to UPLOAD_ROOT).

`user_id IS NULL` on either table means the row belongs to the admin-managed
shared pool that every user can browse and attach from. Admins are the only
callers allowed to write into the shared pool.

Also adds `messages.attachments` (JSONB, nullable) so the UI can render the
original attachment chips on user messages after a reload — even if the file
has been deleted since — without a second round-trip.

Revision ID: 0006_files
Revises: 0005_users_roles
Create Date: 2026-04-18 23:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006_files"
down_revision: Union[str, Sequence[str], None] = "0005_users_roles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "file_folders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("file_folders.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    # Prevent two folders with the same name under the same parent for the
    # same owner. (NULL parent_id = root; NULL user_id = shared pool.)
    # We can't use a normal UNIQUE constraint because NULLs don't compare
    # equal, so use a partial unique index per (user bucket, parent bucket).
    op.create_index(
        "uq_file_folders_user_parent_name",
        "file_folders",
        [
            sa.text("COALESCE(user_id::text, '_shared_')"),
            sa.text("COALESCE(parent_id::text, '_root_')"),
            "name",
        ],
        unique=True,
    )

    op.create_table(
        "files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "folder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("file_folders.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("filename", sa.String(length=512), nullable=False),
        sa.Column("original_filename", sa.String(length=512), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        # Relative to the upload root on disk. We never surface this to the
        # client; downloads go through the authenticated /api/files/{id}
        # endpoint so the access rules live in one place.
        sa.Column("storage_path", sa.String(length=1024), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.add_column(
        "messages",
        sa.Column(
            "attachments",
            postgresql.JSONB(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("messages", "attachments")
    op.drop_table("files")
    op.drop_index("uq_file_folders_user_parent_name", table_name="file_folders")
    op.drop_table("file_folders")

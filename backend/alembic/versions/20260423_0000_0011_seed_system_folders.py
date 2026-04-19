"""Backfill the four system folders for every existing user.

Promptly used to create ``Chat Uploads`` / ``Generated Files`` / ``Files``
/ ``Media`` lazily on first use. We've since promoted them to "always
present from day one" — every account opens to a populated Files page,
no upload required to make them appear (see
``app.files.system_folders.seed_system_folders``).

This migration brings existing accounts into line by inserting any of
the four rows that aren't already there. It is idempotent (every
INSERT is gated by ``NOT EXISTS``) and conflict-tolerant: a user who
happens to have a hand-made folder of the same name at the same parent
keeps it untouched and simply won't get the system version, mirroring
the behaviour of the runtime ``_ensure`` helper.

Revision ID: 0011_seed_system_folders
Revises: 0010_system_folders
Create Date: 2026-04-23 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0011_seed_system_folders"
down_revision: Union[str, Sequence[str], None] = "0010_system_folders"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Postgres 13+ ships ``gen_random_uuid()`` in core (no pgcrypto extension
# required), and our docker-compose pins postgres:15-alpine, so we can
# rely on it directly here for primary-key generation.

# Insert order matters: the two leaf folders below reference the
# generated_root row created in step 2, so they must run after it.

_INSERT_CHAT_UPLOADS = """
    INSERT INTO file_folders (id, user_id, parent_id, name, system_kind, created_at)
    SELECT gen_random_uuid(), u.id, NULL, 'Chat Uploads', 'chat_uploads', now()
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.system_kind = 'chat_uploads'
    )
      AND NOT EXISTS (
        -- Don't collide with a hand-made root folder that happens to
        -- share the canonical name. The user keeps theirs; routing
        -- falls back to the lazy path, which will surface the same
        -- name conflict and prompt them to rename it.
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.parent_id IS NULL AND f.name = 'Chat Uploads'
      );
"""

_INSERT_GENERATED_ROOT = """
    INSERT INTO file_folders (id, user_id, parent_id, name, system_kind, created_at)
    SELECT gen_random_uuid(), u.id, NULL, 'Generated Files', 'generated_root', now()
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.system_kind = 'generated_root'
    )
      AND NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.parent_id IS NULL AND f.name = 'Generated Files'
      );
"""

# These two only run for users that successfully got a generated_root
# above (or already had one). The JOIN naturally filters out anyone
# who lost the previous race against a manually named root folder.

_INSERT_GENERATED_FILES = """
    INSERT INTO file_folders (id, user_id, parent_id, name, system_kind, created_at)
    SELECT gen_random_uuid(), u.id, root.id, 'Files', 'generated_files', now()
    FROM users u
    JOIN file_folders root
      ON root.user_id = u.id AND root.system_kind = 'generated_root'
    WHERE NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.system_kind = 'generated_files'
    )
      AND NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.parent_id = root.id AND f.name = 'Files'
      );
"""

_INSERT_GENERATED_MEDIA = """
    INSERT INTO file_folders (id, user_id, parent_id, name, system_kind, created_at)
    SELECT gen_random_uuid(), u.id, root.id, 'Media', 'generated_media', now()
    FROM users u
    JOIN file_folders root
      ON root.user_id = u.id AND root.system_kind = 'generated_root'
    WHERE NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.system_kind = 'generated_media'
    )
      AND NOT EXISTS (
        SELECT 1 FROM file_folders f
        WHERE f.user_id = u.id AND f.parent_id = root.id AND f.name = 'Media'
      );
"""


def upgrade() -> None:
    op.execute(_INSERT_CHAT_UPLOADS)
    op.execute(_INSERT_GENERATED_ROOT)
    op.execute(_INSERT_GENERATED_FILES)
    op.execute(_INSERT_GENERATED_MEDIA)


def downgrade() -> None:
    # Wipe the rows we inserted (the schema-level ``system_kind``
    # column itself is owned by the previous migration). Files that
    # were uploaded *into* these folders meanwhile have their
    # ``folder_id`` set to NULL by the existing ON DELETE SET NULL
    # FK, so nothing is orphaned.
    #
    # Order: leaves first, then root, so the parent_id FK never
    # complains even if cascade weren't configured.
    op.execute(
        "DELETE FROM file_folders "
        "WHERE system_kind IN ('generated_files', 'generated_media');"
    )
    op.execute(
        "DELETE FROM file_folders WHERE system_kind = 'generated_root';"
    )
    op.execute(
        "DELETE FROM file_folders WHERE system_kind = 'chat_uploads';"
    )

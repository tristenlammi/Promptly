"""The Photos folder: Camera Uploads becomes "Photos", the photo library.

Photos is now only what's in this locked system folder (and its
subfolders), like Google Photos. Every user gets one:

* their Camera Uploads is renamed "Photos" (unless they already have a
  top-level folder called that — then it keeps its name);
* else a top-level folder of theirs called "Photos" becomes it;
* else a new, empty "Photos" is made.

Nothing is moved: pictures elsewhere in My files stay ordinary files.

Revision ID: 0226_photos_folder
Revises: 0225_app_password_delete
"""
from alembic import op

revision = "0226_photos_folder"
down_revision = "0225_app_password_delete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE file_folders f SET name = 'Photos', updated_at = now()
        WHERE f.system_kind = 'camera_uploads' AND f.trashed_at IS NULL AND f.name = 'Camera Uploads'
          AND NOT EXISTS (
            SELECT 1 FROM file_folders o
            WHERE o.user_id = f.user_id AND o.parent_id IS NULL AND o.trashed_at IS NULL
              AND o.name = 'Photos' AND o.id <> f.id
          )
        """
    )
    op.execute(
        """
        UPDATE file_folders f SET system_kind = 'camera_uploads', updated_at = now()
        WHERE f.parent_id IS NULL AND f.trashed_at IS NULL AND f.system_kind IS NULL AND f.name = 'Photos'
          AND f.user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM file_folders c WHERE c.user_id = f.user_id AND c.system_kind = 'camera_uploads')
        """
    )
    op.execute(
        """
        INSERT INTO file_folders (id, user_id, parent_id, name, system_kind, hide_from_photos, created_at, updated_at)
        SELECT gen_random_uuid(), u.id, NULL, 'Photos', 'camera_uploads', false, now(), now()
        FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM file_folders c WHERE c.user_id = u.id AND c.system_kind = 'camera_uploads')
          AND NOT EXISTS (
            SELECT 1 FROM file_folders o
            WHERE o.user_id = u.id AND o.parent_id IS NULL AND o.trashed_at IS NULL AND o.name = 'Photos'
          )
        """
    )
    # The "only these folders" choice (v0.9.4) is gone: Photos is the folder.
    op.execute("UPDATE users SET settings = settings - 'photos_folders' WHERE settings ? 'photos_folders'")


def downgrade() -> None:
    op.execute(
        "UPDATE file_folders SET name = 'Camera Uploads' WHERE system_kind = 'camera_uploads' AND name = 'Photos'"
    )

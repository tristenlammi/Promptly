"""Detach other people's files from custom models (admin privacy, AP3).

Attaching a file to a custom model only checked that the file existed, so an
admin could attach any user's file and make it searchable through the model
(audit L1). The router now allows only files the caller may read. This
detaches what's already there under the same rule: a file stays attached
only if the model's creator can still read it (owns it, or it was shared
with them). If the model's creator has been deleted, every file still
attached belongs to someone else, so all of them are detached.

The file's chunks in that model go too, because retrieval reads chunks by
model, not through the pivot. Only the count is logged, never a name.

The rule below is a frozen copy of ``app.files.access.readable_predicate``
as of this revision, so later changes to that helper can't change what this
migration did.

Revision ID: 0403_cm_foreign_files
Revises: 0272_porch_push
"""
import logging

from alembic import op
from sqlalchemy import text

revision = "0403_cm_foreign_files"
down_revision = "0272_porch_push"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

_FOREIGN = """
    SELECT cmf.custom_model_id, cmf.user_file_id
    FROM custom_model_files AS cmf
    JOIN custom_models AS cm ON cm.id = cmf.custom_model_id
    JOIN files AS f ON f.id = cmf.user_file_id
    WHERE cm.created_by IS NULL
       OR NOT (
            f.user_id = cm.created_by
            OR EXISTS (
                SELECT 1 FROM resource_grants AS rg
                WHERE rg.grantee_user_id = cm.created_by
                  AND rg.resource_type = 'file'
                  AND rg.resource_id = f.id
                  AND (rg.via_link_id IS NULL OR EXISTS (
                      SELECT 1 FROM file_share_links AS sl
                      WHERE sl.id = rg.via_link_id AND sl.revoked_at IS NULL
                        AND (sl.expires_at IS NULL OR sl.expires_at > now())))
            )
            OR (f.folder_id IS NOT NULL AND f.folder_id IN (
                WITH RECURSIVE granted(id) AS (
                    SELECT rg.resource_id FROM resource_grants AS rg
                    WHERE rg.grantee_user_id = cm.created_by AND rg.resource_type = 'folder'
                    UNION
                    SELECT c.id FROM file_folders AS c JOIN granted ON c.parent_id = granted.id
                )
                SELECT id FROM granted
            ))
            OR EXISTS (
                SELECT 1 FROM album_items AS ai JOIN albums AS al ON al.id = ai.album_id
                WHERE ai.file_id = f.id
                  AND (al.owner_id = cm.created_by OR EXISTS (
                      SELECT 1 FROM album_members AS am
                      WHERE am.album_id = al.id AND am.user_id = cm.created_by))
            )
            OR EXISTS (
                SELECT 1 FROM photo_family_items AS fi
                JOIN photo_family_members AS fm
                  ON fm.family_id = fi.family_id AND fm.user_id = cm.created_by
                WHERE fi.file_id = f.id
            )
       )
"""


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text(f"CREATE TEMP TABLE _cm_foreign ON COMMIT DROP AS {_FOREIGN}"))
    n = bind.execute(text("SELECT count(*) FROM _cm_foreign")).scalar() or 0
    if n:
        bind.execute(
            text(
                """
                DELETE FROM knowledge_chunks AS kc
                USING _cm_foreign AS x
                WHERE kc.custom_model_id = x.custom_model_id
                  AND kc.user_file_id = x.user_file_id
                """
            )
        )
        bind.execute(
            text(
                """
                DELETE FROM custom_model_files AS cmf
                USING _cm_foreign AS x
                WHERE cmf.custom_model_id = x.custom_model_id
                  AND cmf.user_file_id = x.user_file_id
                """
            )
        )
    bind.execute(text("DROP TABLE _cm_foreign"))
    log.info("0403_cm_foreign_files: detached %d file(s) the model's creator can't read", n)


def downgrade() -> None:
    # Detached files can't be put back: nothing records which they were.
    pass

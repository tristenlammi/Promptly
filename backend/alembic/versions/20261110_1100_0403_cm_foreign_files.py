"""Detach other people's files from custom models (admin privacy, AP3).

Attaching a file to a custom model only checked that the file existed, so an
admin could attach any user's file and make it searchable through the model
(audit L1). The router now allows only files the caller owns: a file shared
with the admin was shared with them alone, and a model widens who sees it.
This detaches what's already there under the same rule: a file stays
attached only if the model's creator owns it. If the creator has been
deleted, every file still attached belongs to someone else, so all of them
are detached.

The file's chunks in that model go too, because retrieval reads chunks by
model, not through the pivot. Only the count is logged, never a name.

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
    WHERE cm.created_by IS NULL OR f.user_id <> cm.created_by
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
    log.info("0403_cm_foreign_files: detached %d file(s) the model's creator doesn't own", n)


def downgrade() -> None:
    # Detached files can't be put back: nothing records which they were.
    pass

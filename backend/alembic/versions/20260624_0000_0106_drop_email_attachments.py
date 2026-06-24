"""Remove the leftover Email Attachments system folder.

Email/calendar integration was removed in Phase 12 — nothing creates or
routes into the ``email_attachments`` system folder anymore. But accounts
that connected an email account *before* the removal still carry the
folder row, so it keeps showing up on the Files page (the ``email_mode``
hide logic that used to suppress it was deleted with the rest of email).
Drop those rows.

Any file still parked inside reparents to the owner's Drive root —
``files.folder_id`` is ``ON DELETE SET NULL`` — so no blob is lost. The
folder is always top-level (``parent_id IS NULL``), so the ``parent_id``
CASCADE never reaches a user-created folder.

Revision ID: 0106_drop_email_attachments
Revises: 0105_message_model
Create Date: 2026-06-24 00:00:00

NB: keep the revision id short — ``alembic_version.version_num`` is
``varchar(32)``, so a longer id overflows when alembic records the head.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0106_drop_email_attachments"
down_revision: Union[str, Sequence[str], None] = "0105_message_model"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "DELETE FROM file_folders WHERE system_kind = 'email_attachments'"
    )


def downgrade() -> None:
    # Irreversible by design: the folder was a leftover with no creator
    # left in the code, so there's nothing to recreate it from. The
    # delete is idempotent — re-running ``upgrade`` is a no-op.
    pass

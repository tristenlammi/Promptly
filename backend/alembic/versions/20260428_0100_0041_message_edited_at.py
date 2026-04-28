"""Add ``messages.edited_at`` for in-place assistant edits.

The chat router previously only supported edit-and-resend on user
messages. The new ``PATCH /chat/conversations/{cid}/messages/{mid}``
endpoint lets owners hand-correct the AI's reply (e.g. fix typos,
remove stray placeholder text) without re-streaming. We need a
``edited_at`` column so the UI can render an "edited" badge and
audit logs can spot tampered replies.

* Nullable + no default — every existing row stays NULL (i.e.
  "never edited"), which is the correct semantic for legacy data.
* No backfill required.
* No index — this column is never queried by, only displayed.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0041_message_edited_at"
down_revision: Union[str, None] = "0040_app_settings_origins_vapid"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "edited_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("messages", "edited_at")

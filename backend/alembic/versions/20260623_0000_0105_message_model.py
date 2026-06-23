"""Record which model produced each assistant message.

Adds ``model_id`` to ``messages`` so the UI can show, per assistant turn
(including each regenerated sibling version behind the ‹2/3› pager), which
model was used. Nullable — NULL on user/system rows and on assistant rows
generated before this was tracked. We store the raw model id string (no FK)
so the historical record survives a provider/catalog change; the frontend
resolves it to a friendly display name against the live model list.

Revision ID: 0105_message_model
Revises: 0104_spreadsheet_collab
Create Date: 2026-06-23 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0105_message_model"
down_revision: Union[str, Sequence[str], None] = "0104_spreadsheet_collab"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("model_id", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "model_id")

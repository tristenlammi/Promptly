"""Tool Activity Card: persist the per-turn tool-call log on messages.

``messages.tool_calls`` — compact JSONB list of the tool invocations
that ran while producing an assistant reply ({id, name, ok, error?,
error_kind?, elapsed_ms?, meta?}). Powers the collapsed activity card
in scrollback; attachments/sources stay on their existing columns.

Revision ID: 0145_msg_tool_calls
Revises: 0144_due_reminders
Create Date: 2026-07-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0145_msg_tool_calls"
down_revision: Union[str, Sequence[str], None] = "0144_due_reminders"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("tool_calls", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "tool_calls")

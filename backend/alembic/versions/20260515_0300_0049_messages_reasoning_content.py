"""Messages — persist DeepSeek thinking-mode reasoning_content.

DeepSeek's thinking-mode API has a specific quirk documented at
https://api-docs.deepseek.com/guides/thinking_mode :

* On replies, the assistant returns both ``content`` (final answer)
  and ``reasoning_content`` (chain-of-thought).
* **Without** tool calls, ``reasoning_content`` does NOT need to be
  passed back on subsequent turns — DeepSeek ignores it.
* **With** tool calls, ``reasoning_content`` **MUST** be passed back
  on every subsequent turn or DeepSeek 400s with::

      The `reasoning_content` in the thinking mode must be passed
      back to the API.

Promptly previously dropped ``reasoning_content`` on the floor
(captured only ``delta.content`` in the streaming loop), which
worked fine for plain replies and silently broke any DeepSeek
conversation that used a tool. This migration adds a nullable text
column to ``messages`` so the chat router can capture, persist, and
replay the chain-of-thought on follow-up turns. Other providers
ignore the column entirely; the column is stripped from non-DeepSeek
request bodies in ``provider.py``.

Revision ID: 0049_msgs_reasoning
Revises: 0048_appsettings_defchat
Create Date: 2026-05-15 03:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0049_msgs_reasoning"
down_revision: Union[str, None] = "0048_appsettings_defchat"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("reasoning_content", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "reasoning_content")

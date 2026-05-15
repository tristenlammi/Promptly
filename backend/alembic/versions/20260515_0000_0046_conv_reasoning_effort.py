"""Conversation column — per-chat reasoning effort for DeepSeek.

DeepSeek's hosted API (``api.deepseek.com``) accepts two extra request
fields on ``/chat/completions`` that no other supported provider uses:

* ``thinking: {"type": "enabled" | "disabled"}`` — controls whether the
  model emits a reasoning trace alongside the visible answer.
* ``reasoning_effort: "low" | "medium" | "high"`` — only meaningful
  while ``thinking`` is enabled; trades latency for depth.

We persist a tri-state-plus-off knob on the conversation row so the
user's choice survives across sends without forcing a per-message
override. The legal values mirror the wire shape:

* ``NULL``     — fall back to DeepSeek's API-side default (currently
                 "enabled, medium effort"); also the right state for
                 every non-DeepSeek conversation.
* ``"off"``    — sends ``thinking: {"type": "disabled"}`` so V4 runs
                 in fast non-thinking mode.
* ``"low"`` / ``"medium"`` / ``"high"`` — sends ``thinking: enabled``
  plus the matching ``reasoning_effort`` value.

The column is intentionally a free-form ``varchar(8)`` rather than an
enum: a future DeepSeek API revision (or a different provider that
adopts the same shape) might add ``"minimal"`` or ``"max"`` and we'd
rather not have to ship DDL to absorb that.

Naming note: keeps the revision id short — ``0046_conv_reasoning_effort``
is 27 chars, well under the ``alembic_version.version_num varchar(32)``
limit that bit us on 0045.

Revision ID: 0046_conv_reasoning_effort
Revises: 0045_app_settings_search_cap
Create Date: 2026-05-15 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0046_conv_reasoning_effort"
down_revision: Union[str, None] = "0045_app_settings_search_cap"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "reasoning_effort",
            sa.String(length=8),
            # NULL = "use provider default" (DeepSeek defaults to
            # thinking enabled, medium effort on V4 today). The chat
            # router only attaches the ``thinking`` + ``reasoning_effort``
            # request fields when this column is non-NULL, so existing
            # rows on every other provider are unaffected.
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "reasoning_effort")

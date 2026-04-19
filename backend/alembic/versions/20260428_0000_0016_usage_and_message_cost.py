"""Persist USD cost on the daily rollup and per-message.

Stored as integer micros (``cost_usd_micros``: 1 = $0.000001) instead
of ``Numeric`` so additive rollups stay exact and we never pay for
floating-point drift across millions of rows. The Python side does
the ``int(round(cost_usd * 1_000_000))`` conversion at write time and
divides by 1e6 at read time when surfacing dollars.

Two columns added in the same migration so we don't ship the schema in
a half-state:

* ``usage_daily.cost_usd_micros`` — sum of message-level costs for
  the day. Pairs with the existing token columns and powers the
  admin per-user dollar view (Phase 3).
* ``messages.cost_usd_micros`` — single-message cost, used by the
  message-stats info-icon tooltip in the UI to show "this reply cost
  you ~$0.0123" without the user having to open admin analytics.

Backfill: existing rows get the default 0; we don't have historical
provider cost data to recompute.

Revision ID: 0016_usage_and_message_cost
Revises: 0015_error_events
Create Date: 2026-04-28 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_usage_and_message_cost"
down_revision: Union[str, Sequence[str], None] = "0015_error_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "usage_daily",
        sa.Column(
            "cost_usd_micros",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "messages",
        sa.Column(
            "cost_usd_micros",
            sa.BigInteger(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("messages", "cost_usd_micros")
    op.drop_column("usage_daily", "cost_usd_micros")

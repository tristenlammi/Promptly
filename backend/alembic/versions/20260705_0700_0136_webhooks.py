"""Webhook triggers for automations (Batch 5.2).

* ``tasks.webhook_secret`` — per-task inbound-hook credential. NULL until
  the owner adds a webhook trigger; rotatable independently of other
  tasks (unlike a SECRET_KEY-derived HMAC, which could only ever be
  revoked globally).
* ``task_runs.trigger_payload`` — the inbound request body a webhook run
  started with, exposed to the flow as ``{{trigger.payload}}``. Also
  reused by future event triggers (card-moved, file-uploaded).

Revision ID: 0136_webhooks
Revises: 0135_ws_proposals
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0136_webhooks"
down_revision: Union[str, Sequence[str], None] = "0135_ws_proposals"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("webhook_secret", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "task_runs",
        sa.Column("trigger_payload", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("task_runs", "trigger_payload")
    op.drop_column("tasks", "webhook_secret")

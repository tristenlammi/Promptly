"""Notifications: a switch for each device.

``push_subscriptions.enabled``: off, nothing is pushed to that device. Phones
and tablets start on, anything else starts off, so computers that were
already set up are switched off here (their owner can turn them back on in
Account → Notifications).

Revision ID: 0442_push_device_switch
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0442_push_device_switch"
down_revision = "0441_map_trip_share"
branch_labels = None
depends_on = None

# Keep in step with app/notifications/devices.py.
_MOBILE = "Android|iPhone|iPad|iPod|Mobile|Windows Phone"


def upgrade() -> None:
    op.add_column(
        "push_subscriptions",
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.execute(
        sa.text(
            "UPDATE push_subscriptions SET enabled = false "
            "WHERE user_agent IS NULL OR user_agent !~* :mobile"
        ).bindparams(mobile=_MOBILE)
    )


def downgrade() -> None:
    op.drop_column("push_subscriptions", "enabled")

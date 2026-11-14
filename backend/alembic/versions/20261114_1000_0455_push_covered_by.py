"""Notifications: a browser's subscription on a phone the app covers.

``push_subscriptions.covered_by``: on a phone where the Promptly Android app
shows notifications itself, Chrome's own subscription for the same phone is
marked with the app's (the SHA-256 of its push address). While the app's
subscription exists, nothing is sent to the covered one, so the phone doesn't
get everything twice; if the app's goes, Chrome's carries on by itself.

Revision ID: 0455_push_covered_by
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0455_push_covered_by"
down_revision = "0442_push_device_switch"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("push_subscriptions", sa.Column("covered_by", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("push_subscriptions", "covered_by")

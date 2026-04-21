"""Push notifications — subscriptions table + per-user category prefs.

Two tables:

* ``push_subscriptions`` — one row per (user, device/browser). Stores
  the Web Push subscription triple (``endpoint``, ``p256dh``,
  ``auth``) plus a friendly device label the user can rename, and a
  ``last_used_at`` timestamp that the dispatch helper updates on
  each successful push (lets the Account -> Notifications panel
  show "last active 2h ago" and prune dead devices).

* ``push_preferences`` — one row per user. Holds the boolean-per-
  category toggles (``study_graded``, ``export_ready``,
  ``import_done``, ``shared_message``). Stored as a dedicated table
  rather than a JSONB blob on ``users`` so we can add simple
  WHERE-based fan-out queries later ("send this notification to
  every user who has ``shared_message`` enabled") without doing
  JSON path lookups.

Both tables ``ON DELETE CASCADE`` the user FK so deleting an account
sweeps its subscriptions cleanly and we never end up trying to
deliver a push to a ghost user.

Revision ID: 0028_push_notifications
Revises: 0027_chat_projects
Create Date: 2026-04-20 09:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0028_push_notifications"
down_revision: Union[str, Sequence[str], None] = "0027_chat_projects"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Endpoint uniqueness (per-user) is what makes "re-subscribing
        # from the same browser twice doesn't create duplicates" work;
        # the browser emits the same endpoint URL every time until the
        # subscription is explicitly unsubscribed.
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        # Human-facing label shown on the Devices list. Defaults to a
        # best-effort slug built from the UA on the frontend but users
        # can rename. Capped at 120 so the mobile UI doesn't overflow.
        sa.Column("label", sa.String(120), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "last_used_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "user_id", "endpoint", name="uq_push_subscriptions_user_endpoint"
        ),
    )

    op.create_table(
        "push_preferences",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        # Master switch — if False, dispatch short-circuits before
        # any per-category check. Useful for "mute everything for the
        # weekend" without losing per-category config.
        sa.Column(
            "enabled",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        # Category toggles. Defaults mirror the product decision to
        # notify on *completions* (things the user cares about when
        # they're away from the tab) but stay quiet on low-signal
        # events.
        sa.Column(
            "study_graded",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "export_ready",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "import_done",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "shared_message",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        # "Quiet hours" is a natural next step but we intentionally
        # ship without it — one config surface, one decision per
        # category, and an easily understood mute switch for the
        # occasional "please stop" moment.
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("push_preferences")
    op.drop_table("push_subscriptions")

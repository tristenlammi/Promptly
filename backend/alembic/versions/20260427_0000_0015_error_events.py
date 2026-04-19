"""Persist captured exceptions in an ``error_events`` table.

Used by the admin Live Console (errors tab) to group recurring
failures by ``fingerprint`` (sha256 of ``level:logger:exception_class:
normalized_msg``) and surface "first seen / last seen / count /
affected users" without an external service like Sentry.

We keep every row (no per-event dedup) so the timeline view inside a
group can show the actual occurrence pattern. Grouping happens at
query time via a window over ``fingerprint``. The
``(fingerprint, created_at desc)`` index makes that grouping a
sequential index walk; no sort step needed.

``user_id`` is nullable because some errors fire before auth
resolves (request-context middleware exception, etc.). FK is
``ON DELETE SET NULL`` so deleting a user keeps the historical
errors but anonymises them, matching how the audit log behaves.

Revision ID: 0015_error_events
Revises: 0014_messages_conv_created_idx
Create Date: 2026-04-27 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015_error_events"
down_revision: Union[str, Sequence[str], None] = "0014_messages_conv_created_idx"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "error_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # sha256 of "level:logger:exception_class:normalized_msg" — used
        # to group occurrences. Stored as the lower-case hex string so
        # equality lookups don't need a hash function on each query.
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("level", sa.String(length=16), nullable=False),
        sa.Column("logger", sa.String(length=128), nullable=False),
        sa.Column("exception_class", sa.String(length=128), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("stack", sa.Text(), nullable=True),
        sa.Column("route", sa.String(length=255), nullable=True),
        sa.Column("method", sa.String(length=8), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "extra",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        # Resolved-by-admin marker. Null = open. Once set the timeline
        # view stops counting subsequent occurrences against the open
        # tally (they re-open the group automatically — the admin can
        # mark resolved again).
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "resolved_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # Grouping by fingerprint is the dominant query — recent first.
    op.create_index(
        "ix_error_events_fingerprint_created_at",
        "error_events",
        ["fingerprint", sa.text("created_at DESC")],
    )
    # "Recent errors across the box" — admin dashboard sparkline.
    op.create_index(
        "ix_error_events_created_at",
        "error_events",
        [sa.text("created_at DESC")],
    )
    # "What did user X hit?" — drill-down from the analytics page.
    op.create_index(
        "ix_error_events_user_created_at",
        "error_events",
        ["user_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_error_events_user_created_at", table_name="error_events")
    op.drop_index("ix_error_events_created_at", table_name="error_events")
    op.drop_index(
        "ix_error_events_fingerprint_created_at", table_name="error_events"
    )
    op.drop_table("error_events")

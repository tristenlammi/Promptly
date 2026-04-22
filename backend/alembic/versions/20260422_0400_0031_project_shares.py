"""Project-level sharing — give another user complete access to a chat
project (all its chats, including the inviter's, plus settings and
pinned files).

This mirrors the 0018 conversation-share table shape so the invite
lifecycle (pending → accepted / declined, or deleted to revoke)
stays identical across both kinds of share. The key difference is
the **access fan-out**: accepting a project share unlocks every
conversation under that project to the invitee, past and future
— the resolver in ``app/chat/shares.py`` walks the project_shares
table as a second path into ``list_accessible_conversation_ids``
and friends.

Design choices:

* Standalone ``project_shares`` table (not a JSONB column on
  ``chat_projects``) so the invite lifecycle — pending / accepted
  / accepted_at — is a plain row with a unique constraint and we
  can add a ``(invitee_user_id, status)`` index for the "share
  invites" inbox the same way conversation_shares did.
* ``inviter_user_id`` is a plain FK, not the project owner. This
  matters only if we ever let non-owner collaborators invite
  others (not shipped in this migration but the column is ready).
* ``ON DELETE CASCADE`` on both ``project_id`` and the user FKs so
  deleting a project — or a user — doesn't leave orphan share
  rows pointing at vanished records.

Revision ID: 0031_project_shares
Revises: 0030_conversation_summary_cache
Create Date: 2026-04-22 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0031_project_shares"
down_revision: Union[str, Sequence[str], None] = "0030_conversation_summary_cache"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_shares",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "inviter_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "invitee_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Lifecycle: pending → accepted (or declined, deleted to
        # revoke). Stored as plain string to mirror conversation_shares
        # rather than a Postgres enum — keeps future status additions
        # (eg. "paused") a no-op migration.
        sa.Column(
            "status",
            sa.String(16),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
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
        sa.UniqueConstraint(
            "project_id",
            "invitee_user_id",
            name="uq_project_shares_project_invitee",
        ),
    )
    # Inbox hot path: "show me the projects I've been invited to".
    op.create_index(
        "ix_project_shares_invitee_status",
        "project_shares",
        ["invitee_user_id", "status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_project_shares_invitee_status", table_name="project_shares"
    )
    op.drop_table("project_shares")

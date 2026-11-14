"""Rooms: no switch lets the AI read a room.

Owner rule (2026-11-15): Rooms and Porch are never read or indexed by AI;
``@promptly`` sees only the one message that mentions it. The room admins'
"Promptly can read this room" (``rooms.ai_context``) and each DM member's
consent (``room_members.ai_ok``) are dropped with everything that used them.

Revision ID: 0475_rooms_no_ai_read
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0475_rooms_no_ai_read"
down_revision = "0470_rooms_receipts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("rooms", "ai_context")
    op.drop_column("room_members", "ai_ok")


def downgrade() -> None:
    op.add_column("room_members", sa.Column("ai_ok", sa.Boolean, nullable=False, server_default="false"))
    op.add_column("rooms", sa.Column("ai_context", sa.Boolean, nullable=False, server_default="false"))

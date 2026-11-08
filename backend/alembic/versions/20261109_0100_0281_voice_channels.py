"""Calls: voice channels in Rooms (WP-V2).

* ``rooms.kind`` gains ``voice`` (String(8), no type change).
* ``room_voice``: a voice channel's settings (user limit, quality, who can
  join and talk, video and Go Live, the alone timeout).
* ``calls`` / ``call_participants``: one row per voice session (first join
  until the channel empties) and who was in it, for history and usage only.
  Live state (who's in, muted, speaking) is in Redis, never here.

Revision ID: 0281_voice_channels
Revises: 0280_calls_settings
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0281_voice_channels"
down_revision = "0280_calls_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "room_voice",
        sa.Column("room_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_limit", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("quality", sa.String(8), nullable=False, server_default="good"),
        sa.Column("join_role", sa.String(8), nullable=False, server_default="member"),
        sa.Column("talk_role", sa.String(8), nullable=False, server_default="member"),
        sa.Column("video", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("alone_minutes", sa.Integer(), nullable=True, server_default="15"),
        sa.CheckConstraint("user_limit >= 0 AND user_limit <= 99", name="ck_room_voice_user_limit"),
        sa.CheckConstraint("quality IN ('standard', 'good', 'high', 'music')", name="ck_room_voice_quality"),
        sa.CheckConstraint("join_role IN ('member', 'admin')", name="ck_room_voice_join_role"),
        sa.CheckConstraint("talk_role IN ('member', 'admin')", name="ck_room_voice_talk_role"),
    )
    op.create_table(
        "calls",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False, server_default="voice"),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=True),
        sa.Column("lk_room", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_calls_room_id", "calls", ["room_id"])
    # One open session per voice channel.
    op.create_index(
        "uq_calls_room_open", "calls", ["room_id"], unique=True, postgresql_where=sa.text("ended_at IS NULL")
    )
    op.create_table(
        "call_participants",
        sa.Column("call_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("calls.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("identity", sa.String(80), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("display_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("first_joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seconds", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_call_participants_user_id", "call_participants", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_call_participants_user_id", table_name="call_participants")
    op.drop_table("call_participants")
    op.drop_index("uq_calls_room_open", table_name="calls")
    op.drop_index("ix_calls_room_id", table_name="calls")
    op.drop_table("calls")
    op.drop_table("room_voice")
    op.execute("DELETE FROM rooms WHERE kind = 'voice'")

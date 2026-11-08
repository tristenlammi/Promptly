"""Calls phase 2: voice and video calls in DMs (1:1 and group).

``calls`` gains who started it, audio or video, when someone first answered
and how it ended. ``call_participants`` becomes the ring and presence record
of a DM call: everyone rung gets a row (``ring`` ringing / answered /
declined / missed), ``in_call_since`` says who's connected now, and
``first_joined_at`` is NULL for someone who never joined. ``push_preferences``
gains ``call`` (ringing and missed calls; never held by quiet hours).

Revision ID: 0282_calls_dm
Revises: 0281_voice_channels
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0282_calls_dm"
down_revision = "0281_voice_channels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "calls",
        sa.Column("started_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("calls", sa.Column("media", sa.String(8), nullable=True))
    op.add_column("calls", sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("calls", sa.Column("ended_reason", sa.String(12), nullable=True))
    op.create_check_constraint("ck_calls_media", "calls", "media IS NULL OR media IN ('audio', 'video')")
    op.create_check_constraint(
        "ck_calls_ended_reason",
        "calls",
        "ended_reason IS NULL OR ended_reason IN ('completed', 'missed', 'cancelled', 'declined', 'ended')",
    )

    op.alter_column("call_participants", "first_joined_at", existing_type=sa.DateTime(timezone=True), nullable=True)
    op.add_column("call_participants", sa.Column("ring", sa.String(10), nullable=True))
    op.add_column("call_participants", sa.Column("rung_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("call_participants", sa.Column("in_call_since", sa.DateTime(timezone=True), nullable=True))
    op.add_column("call_participants", sa.Column("session", sa.String(32), nullable=True))
    op.add_column("call_participants", sa.Column("device", sa.String(8), nullable=True))
    op.add_column("call_participants", sa.Column("lk_sid", sa.String(48), nullable=True))
    op.add_column("call_participants", sa.Column("hidden", sa.Boolean(), nullable=False, server_default="false"))
    op.create_check_constraint(
        "ck_call_participants_ring",
        "call_participants",
        "ring IS NULL OR ring IN ('ringing', 'answered', 'declined', 'missed')",
    )
    # Who's in a call right now (one live call per person).
    op.create_index(
        "ix_call_participants_present",
        "call_participants",
        ["user_id"],
        postgresql_where=sa.text("in_call_since IS NOT NULL"),
    )

    op.add_column("push_preferences", sa.Column("call", sa.Boolean(), nullable=False, server_default="true"))


def downgrade() -> None:
    op.drop_column("push_preferences", "call")
    op.drop_index("ix_call_participants_present", table_name="call_participants")
    op.drop_constraint("ck_call_participants_ring", "call_participants", type_="check")
    for col in ("hidden", "lk_sid", "device", "session", "in_call_since", "rung_at", "ring"):
        op.drop_column("call_participants", col)
    op.execute("DELETE FROM calls WHERE kind <> 'voice'")
    op.execute("UPDATE call_participants SET first_joined_at = now() WHERE first_joined_at IS NULL")
    op.alter_column("call_participants", "first_joined_at", existing_type=sa.DateTime(timezone=True), nullable=False)
    op.drop_constraint("ck_calls_ended_reason", "calls", type_="check")
    op.drop_constraint("ck_calls_media", "calls", type_="check")
    for col in ("ended_reason", "answered_at", "media", "started_by"):
        op.drop_column("calls", col)

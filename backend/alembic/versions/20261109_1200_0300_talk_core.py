"""Talk core (WP-T2): spoken turns marked on messages, per-turn timings, and
the server switches for Talk.

* ``messages.voice``: ``{spoken, interrupted, heard_chars, stt_ms}`` on spoken
  user turns and spoken replies (NULL on everything else).
* ``talk_metrics``: one row per answered turn, timings only, never words.
* ``app_settings.talk_enabled`` / ``talk_group_ids`` / ``talk_live_slots``.

Revision ID: 0300_talk_core
Revises: 0330_mail_html_clipped
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0300_talk_core"
down_revision = "0330_mail_html_clipped"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("voice", postgresql.JSONB, nullable=True))

    op.create_table(
        "talk_metrics",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("session_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("device", sa.String(16), nullable=False),
        sa.Column("transport", sa.String(16), nullable=False),
        sa.Column("endpoint_ms", sa.Integer, nullable=True),
        sa.Column("stt_ms", sa.Integer, nullable=True),
        sa.Column("ttft_ms", sa.Integer, nullable=True),
        sa.Column("first_audio_ms", sa.Integer, nullable=True),
        sa.Column("tool_ms", sa.Integer, nullable=True),
        sa.Column("barge_ins", sa.Integer, nullable=False, server_default="0"),
        sa.Column("fast_path", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("device IN ('web', 'android', 'car')", name="ck_talk_metrics_device"),
        sa.CheckConstraint("transport IN ('ws', 'fallback')", name="ck_talk_metrics_transport"),
    )
    op.create_index("ix_talk_metrics_created_at", "talk_metrics", ["created_at"])

    op.add_column("app_settings", sa.Column("talk_enabled", sa.Boolean, nullable=False, server_default="true"))
    op.add_column("app_settings", sa.Column("talk_group_ids", postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=True))
    op.add_column("app_settings", sa.Column("talk_live_slots", sa.Integer, nullable=False, server_default="2"))


def downgrade() -> None:
    op.drop_column("app_settings", "talk_live_slots")
    op.drop_column("app_settings", "talk_group_ids")
    op.drop_column("app_settings", "talk_enabled")
    op.drop_index("ix_talk_metrics_created_at", table_name="talk_metrics")
    op.drop_table("talk_metrics")
    op.drop_column("messages", "voice")

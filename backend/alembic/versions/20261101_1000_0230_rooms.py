"""Rooms: spaces of text rooms + direct messages between the people on
this Promptly (app/rooms). Private by default — nothing is indexed.

* ``room_spaces`` / ``room_space_members`` — a group and its people.
* ``rooms`` — a space's text room, or a DM (``space_id`` NULL).
* ``room_members`` — DM membership, and everyone's read state / settings.
* ``room_messages`` (``seq`` per room), ``room_reactions``, ``room_attachments``.
* ``push_preferences.room_message``.

Revision ID: 0230_rooms
Revises: 0229_item_store
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0230_rooms"
down_revision = "0229_item_store"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def _now() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    op.create_table(
        "room_spaces",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("emoji", sa.String(16), nullable=False, server_default=""),
        sa.Column("color", sa.String(9), nullable=False, server_default="#5B6DD9"),
        sa.Column("created_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        _now(),
    )
    op.create_table(
        "room_space_members",
        sa.Column("space_id", _UUID, sa.ForeignKey("room_spaces.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(8), nullable=False, server_default="member"),
        sa.Column("notify", sa.String(8), nullable=False, server_default="all"),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_room_space_members_user_id", "room_space_members", ["user_id"])
    op.create_table(
        "rooms",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("space_id", _UUID, sa.ForeignKey("room_spaces.id", ondelete="CASCADE"), nullable=True),
        sa.Column("kind", sa.String(8), nullable=False, server_default="text"),
        sa.Column("name", sa.String(80), nullable=False, server_default=""),
        sa.Column("topic", sa.String(300), nullable=False, server_default=""),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("ai_context", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("created_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("last_seq", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        _now(),
    )
    op.create_index("ix_rooms_space_id", "rooms", ["space_id"])
    op.create_table(
        "room_members",
        sa.Column("room_id", _UUID, sa.ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("last_read_seq", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("notify", sa.String(8), nullable=True),
        sa.Column("ai_ok", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("hidden", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_room_members_user_id", "room_members", ["user_id"])
    op.create_table(
        "room_messages",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("room_id", _UUID, sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seq", sa.BigInteger, nullable=False),
        sa.Column("author_id", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(10), nullable=False, server_default="user"),
        sa.Column("body", sa.Text, nullable=False, server_default=""),
        sa.Column("reply_to_id", _UUID, sa.ForeignKey("room_messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("mentions", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("meta", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pinned_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        _now(),
        sa.UniqueConstraint("room_id", "seq", name="uq_room_messages_room_seq"),
    )
    op.create_table(
        "room_reactions",
        sa.Column("message_id", _UUID, sa.ForeignKey("room_messages.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("emoji", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "room_attachments",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("room_id", _UUID, sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message_id", _UUID, sa.ForeignKey("room_messages.id", ondelete="CASCADE"), nullable=True),
        sa.Column("uploader_id", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("mime", sa.String(127), nullable=False, server_default="application/octet-stream"),
        sa.Column("size", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("width", sa.Integer, nullable=True),
        sa.Column("height", sa.Integer, nullable=True),
        sa.Column("has_thumb", sa.Boolean, nullable=False, server_default="false"),
        _now(),
    )
    op.create_index("ix_room_attachments_room_id", "room_attachments", ["room_id"])
    op.create_index("ix_room_attachments_message_id", "room_attachments", ["message_id"])
    op.add_column(
        "push_preferences",
        sa.Column("room_message", sa.Boolean, nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("push_preferences", "room_message")
    for t in ("room_attachments", "room_reactions", "room_messages", "room_members", "rooms", "room_space_members", "room_spaces"):
        op.drop_table(t)

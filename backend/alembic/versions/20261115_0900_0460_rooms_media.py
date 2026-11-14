"""Rooms: GIFs, link previews, custom emoji and the admin's Rooms settings.

* ``app_settings.rooms_settings`` (JSONB): the server-wide Rooms switches
  (``app/rooms/settings.py``). A new switch is a new key, not a new column.
* ``app_settings.rooms_gif_key_encrypted``: the GIF library's key, Fernet.
* ``room_attachments.animated``: a GIF or animated WebP, played in the chat.
* ``room_saved_gifs``: each person's saved GIFs (their own copy of the file,
  or a reference to one in the GIF library).
* ``room_emojis``: a space's own emoji.

Revision ID: 0460_rooms_media
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0460_rooms_media"
down_revision = "0455_push_covered_by"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column("rooms_settings", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column("app_settings", sa.Column("rooms_gif_key_encrypted", sa.Text(), nullable=True))
    op.add_column(
        "room_attachments",
        sa.Column("animated", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_table(
        "room_saved_gifs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(8), nullable=False, server_default="own"),
        sa.Column("filename", sa.String(255), nullable=False, server_default=""),
        sa.Column("mime", sa.String(127), nullable=False, server_default="image/gif"),
        sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("data", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_room_saved_gifs_user_id", "room_saved_gifs", ["user_id"])
    op.create_table(
        "room_emojis",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("space_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("room_spaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(30), nullable=False),
        sa.Column("mime", sa.String(127), nullable=False, server_default="image/png"),
        sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("animated", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("space_id", "name", name="uq_room_emojis_space_name"),
    )
    op.create_index("ix_room_emojis_space_id", "room_emojis", ["space_id"])


def downgrade() -> None:
    op.drop_index("ix_room_emojis_space_id", table_name="room_emojis")
    op.drop_table("room_emojis")
    op.drop_index("ix_room_saved_gifs_user_id", table_name="room_saved_gifs")
    op.drop_table("room_saved_gifs")
    op.drop_column("room_attachments", "animated")
    op.drop_column("app_settings", "rooms_gif_key_encrypted")
    op.drop_column("app_settings", "rooms_settings")

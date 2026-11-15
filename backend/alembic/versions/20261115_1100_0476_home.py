"""Promptly Home: homes, their members and their boxes.

``homes`` / ``home_members``: a household and who is in it (owner, member). ``home_boxes``: the small computer in a home that runs Home Assistant
and dials out to this server (``app/home/relay.py``); prepared by an admin,
claimed into a home with the code on its card. Only hashes of a box's key and
claim code are kept. ``app_settings.home_enabled``: the whole feature, off
until an admin turns it on.

Revision ID: 0476_home
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0476_home"
down_revision = "0475_rooms_no_ai_read"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "homes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_homes_owner_id", "homes", ["owner_id"])
    op.create_table(
        "home_members",
        sa.Column("home_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("homes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(8), nullable=False, server_default="member"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_home_members_user_id", "home_members", ["user_id"])
    op.create_table(
        "home_boxes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("label", sa.String(80), nullable=False, server_default=""),
        sa.Column("name", sa.String(80), nullable=True),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("claim_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("home_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("homes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("claimed_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.String(32), nullable=True),
        sa.Column("snapshot", postgresql.JSONB(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_home_boxes_home_id", "home_boxes", ["home_id"])
    op.add_column("app_settings", sa.Column("home_enabled", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("app_settings", "home_enabled")
    op.drop_index("ix_home_boxes_home_id", table_name="home_boxes")
    op.drop_table("home_boxes")
    op.drop_index("ix_home_members_user_id", table_name="home_members")
    op.drop_table("home_members")
    op.drop_index("ix_homes_owner_id", table_name="homes")
    op.drop_table("homes")

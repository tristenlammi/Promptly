"""Family library (PH-5): people on this server pooling photos.

A family has members; each member chooses what of their library goes in
(all of it, from a date, photos with certain people, or nothing — the
default). What's in is kept in ``photo_family_items`` (refreshed as photos
arrive), so who may read a photo stays one indexed lookup.

Revision ID: 0224_photo_family
Revises: 0223_photo_edits
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0224_photo_family"
down_revision = "0223_photo_edits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_families",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "photo_family_members",
        sa.Column("family_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("photo_families.id", ondelete="CASCADE"), nullable=False),
        # One family per person.
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("share_mode", sa.String(8), nullable=False, server_default="none"),  # none | all | since | people
        sa.Column("share_since", sa.Date, nullable=True),
        sa.Column("share_people", postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("share_mode IN ('none', 'all', 'since', 'people')", name="ck_photo_family_share_mode"),
    )
    op.create_index("ix_photo_family_members_family", "photo_family_members", ["family_id"])
    op.create_table(
        "photo_family_items",
        sa.Column("family_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("photo_families.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    )
    op.create_index("ix_photo_family_items_file", "photo_family_items", ["file_id"])
    op.create_index("ix_photo_family_items_owner", "photo_family_items", ["family_id", "owner_id"])


def downgrade() -> None:
    op.drop_table("photo_family_items")
    op.drop_table("photo_family_members")
    op.drop_table("photo_families")

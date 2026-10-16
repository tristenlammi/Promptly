"""Relationship labels (PH-3, Part E §E3): "my wife", "Mum", "my son" —
each user's own words for a person in a library they can see. Never shared:
"my wife" means someone different to everyone. The normalised ``kind`` is
what "me and my wife" resolves through (PH-4).

Revision ID: 0219_photo_relations
Revises: 0218_photo_people
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0219_photo_relations"
down_revision = "0218_photo_people"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_relationships",
        sa.Column("viewer_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("person_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("photo_people.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("label", sa.String(60), nullable=False),
        # spouse, partner, child, parent, sibling, grandparent, grandchild,
        # relative, friend, colleague — or other.
        sa.Column("kind", sa.String(16), nullable=False),
        # How it was said: in People (settings) or confirmed from a chat.
        sa.Column("source", sa.String(16), nullable=False, server_default="settings"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_photo_relationships_kind", "photo_relationships", ["viewer_user_id", "kind"])


def downgrade() -> None:
    op.drop_index("ix_photo_relationships_kind", table_name="photo_relationships")
    op.drop_table("photo_relationships")

"""Memories (PH-5): "On this day", trips, "Max's first year", "You & Sarah"
— stories made from what understanding already knows, for their owner only.

A memory is a titled, ordered set of photos with a ``key`` that names what
it is about (``trip:2024-03-12``, ``first_year:<pet>``), so remaking them
updates a story rather than adding a second one, and a dismissed one stays
dismissed. ``photo_people.memories_hidden`` is "don't show me memories of
this person".

Revision ID: 0221_photo_memories
Revises: 0220_smart_albums
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0221_photo_memories"
down_revision = "0220_smart_albums"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_memories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),  # on_this_day | trip | first_year | together
        sa.Column("key", sa.String(120), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("subtitle", sa.String(200), nullable=False, server_default=""),
        sa.Column("period_start", sa.Date, nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        sa.Column("file_ids", postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=False),
        sa.Column("cover_file_id", postgresql.UUID(as_uuid=True), nullable=True),
        # The person or pet it is about (first_year, together).
        sa.Column("person_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("photo_people.id", ondelete="CASCADE"), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "key", name="uq_photo_memories_key"),
    )
    op.add_column("photo_people", sa.Column("memories_hidden", sa.Boolean, nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("photo_people", "memories_hidden")
    op.drop_table("photo_memories")

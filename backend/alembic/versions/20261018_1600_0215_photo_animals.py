"""Animals in photos (PH-2, WP-PH2.4): where each is, what kind (SigLIP on
the crop), and two vectors of it (SigLIP 2, DINOv2) for PH-3 to match
against the household's named pets.

Revision ID: 0215_photo_animals
Revises: 0214_photo_faces
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0215_photo_animals"
down_revision = "0214_photo_faces"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_animals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("species", sa.String(24), nullable=False),
        sa.Column("box_x", sa.Float, nullable=False),
        sa.Column("box_y", sa.Float, nullable=False),
        sa.Column("box_w", sa.Float, nullable=False),
        sa.Column("box_h", sa.Float, nullable=False),
        sa.Column("score", sa.Float, nullable=False),
        sa.Column("size_px", sa.Integer, nullable=False),
        sa.Column("model", sa.String(64), nullable=False),
        # Which pet (PH-3), and whether a person said so.
        sa.Column("pet_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("assigned_by", sa.String(8), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE photo_animals ADD COLUMN embedding vector(768) NOT NULL")
    op.execute("ALTER TABLE photo_animals ADD COLUMN embedding_dino vector(384) NOT NULL")
    op.create_index("ix_photo_animals_species", "photo_animals", ["user_id", "species"])


def downgrade() -> None:
    op.drop_index("ix_photo_animals_species", table_name="photo_animals")
    op.drop_table("photo_animals")

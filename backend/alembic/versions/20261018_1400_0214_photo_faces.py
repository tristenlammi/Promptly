"""Faces in photos (PH-2, WP-PH2.3): where each face is, and its AuraFace
vector — only for libraries whose owner turned face recognition on.
People (who each face is) come in PH-3.

Revision ID: 0214_photo_faces
Revises: 0213_photo_embeddings
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0214_photo_faces"
down_revision = "0213_photo_embeddings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_faces",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        # Where, as fractions of the picture: x, y, width, height; and the
        # five landmarks (eyes, nose, mouth corners).
        sa.Column("box_x", sa.Float, nullable=False),
        sa.Column("box_y", sa.Float, nullable=False),
        sa.Column("box_w", sa.Float, nullable=False),
        sa.Column("box_h", sa.Float, nullable=False),
        sa.Column("landmarks", postgresql.JSONB, nullable=True),
        sa.Column("score", sa.Float, nullable=False),
        sa.Column("size_px", sa.Integer, nullable=False),
        sa.Column("model", sa.String(64), nullable=False),
        # Who it is (PH-3): a person, and whether that was the machine's
        # guess or someone's say-so (which no re-run overwrites).
        sa.Column("person_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("assigned_by", sa.String(8), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE photo_faces ADD COLUMN embedding vector(512) NOT NULL")
    op.execute("CREATE INDEX ix_photo_faces_hnsw ON photo_faces USING hnsw (embedding vector_cosine_ops)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_photo_faces_hnsw")
    op.drop_table("photo_faces")

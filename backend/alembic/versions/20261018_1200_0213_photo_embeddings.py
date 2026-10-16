"""What's in a photo, as a vector (PH-2, WP-PH2.2): SigLIP 2 image
embeddings from the photos-ml service, searched by text in the same space.

Revision ID: 0213_photo_embeddings
Revises: 0212_photo_understanding
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0213_photo_embeddings"
down_revision = "0212_photo_understanding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_embeddings",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        # Which model and export made it: a different one is re-embedded.
        sa.Column("model", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # pgvector (as knowledge_chunks): written and searched with raw SQL.
    op.execute("ALTER TABLE photo_embeddings ADD COLUMN embedding vector(768) NOT NULL")
    op.execute(
        "CREATE INDEX ix_photo_embeddings_hnsw ON photo_embeddings USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_photo_embeddings_hnsw")
    op.drop_table("photo_embeddings")

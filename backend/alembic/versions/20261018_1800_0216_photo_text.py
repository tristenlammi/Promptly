"""Text in photos (PH-2, WP-PH2.5): the words OCR read in each photo — signs,
menus, screenshots, documents — searchable.

Revision ID: 0216_photo_text
Revises: 0215_photo_animals
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0216_photo_text"
down_revision = "0215_photo_animals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_text",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("text", sa.Text, nullable=False),
        # Each line: its text, where (0–1) and how sure the reader was.
        sa.Column("lines", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("model", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # 'simple': any language, no stemming (a sign's words are what they are).
    op.execute(
        "ALTER TABLE photo_text ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED"
    )
    op.execute("CREATE INDEX ix_photo_text_tsv ON photo_text USING gin (tsv)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_photo_text_tsv")
    op.drop_table("photo_text")

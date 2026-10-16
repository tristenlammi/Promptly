"""Describing photos (PH-2, WP-PH2.6): an admin-chosen "Photos vision" model
(local, or a cloud one people opt into, within a monthly limit) writes a
sentence and tags for each photo — searchable.

Revision ID: 0217_photo_captions
Revises: 0216_photo_text
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0217_photo_captions"
down_revision = "0216_photo_text"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "photos_vision_provider_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.add_column("app_settings", sa.Column("photos_vision_model_id", sa.String(255), nullable=True))
    # Photos a cloud model may describe in a calendar month, across everyone.
    op.add_column(
        "app_settings",
        sa.Column("photos_vision_monthly_limit", sa.Integer, nullable=False, server_default="2000"),
    )
    op.create_table(
        "photo_captions",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("caption", sa.Text, nullable=False),
        sa.Column("tags", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("model", sa.String(255), nullable=False),
        # Sent to a service outside this server (counts against the limit).
        sa.Column("cloud", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute(
        "ALTER TABLE photo_captions ADD COLUMN tsv tsvector GENERATED ALWAYS AS "
        "(to_tsvector('english', caption || ' ' || tags::text)) STORED"
    )
    op.execute("CREATE INDEX ix_photo_captions_tsv ON photo_captions USING gin (tsv)")
    op.create_index("ix_photo_captions_month", "photo_captions", ["cloud", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_photo_captions_month", table_name="photo_captions")
    op.execute("DROP INDEX IF EXISTS ix_photo_captions_tsv")
    op.drop_table("photo_captions")
    op.drop_column("app_settings", "photos_vision_monthly_limit")
    op.drop_column("app_settings", "photos_vision_model_id")
    op.drop_column("app_settings", "photos_vision_provider_id")

"""Understanding photos, part one (PH-2, WP-PH2.1): where each was taken
(an offline GeoNames gazetteer) and how good it is (sharpness, exposure,
a perceptual hash for near-duplicates), with per-photo progress per stage.

Revision ID: 0212_photo_understanding
Revises: 0211_import_meta_archived
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0212_photo_understanding"
down_revision = "0211_import_meta_archived"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # GeoNames (CC BY 4.0): populated places with 500+ people, their states
    # and countries. Loaded by the media worker the first time a photo with
    # a location needs it; reloading replaces the rows.
    op.create_table(
        "geo_places",
        sa.Column("geonameid", sa.Integer, primary_key=True, autoincrement=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("ascii_name", sa.String(200), nullable=False),
        sa.Column("lat", sa.Float, nullable=False),
        sa.Column("lon", sa.Float, nullable=False),
        sa.Column("feature_code", sa.String(10), nullable=False),
        sa.Column("country", sa.String(2), nullable=False),
        sa.Column("admin1", sa.String(20), nullable=False, server_default=""),
        sa.Column("population", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("timezone", sa.String(40), nullable=True),
    )
    op.create_index("ix_geo_places_lat", "geo_places", ["lat"])
    op.create_table(
        "geo_admin1",
        sa.Column("code", sa.String(30), primary_key=True),  # "AU.04"
        sa.Column("name", sa.String(200), nullable=False),
    )
    op.create_table(
        "geo_countries",
        sa.Column("code", sa.String(2), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
    )

    op.add_column("photo_assets", sa.Column("place_id", sa.Integer, nullable=True))
    op.add_column("photo_assets", sa.Column("phash", sa.BigInteger, nullable=True))
    op.add_column("photo_assets", sa.Column("sharpness", sa.Float, nullable=True))
    op.add_column("photo_assets", sa.Column("brightness", sa.Float, nullable=True))
    op.add_column("photo_assets", sa.Column("quality", sa.Float, nullable=True))
    op.create_index("ix_photo_assets_place", "photo_assets", ["user_id", "place_id"])

    op.create_table(
        "photo_understanding",
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("stage", sa.String(16), primary_key=True),
        sa.Column("version", sa.SmallInteger, nullable=False),
        sa.Column("state", sa.String(8), nullable=False),
        sa.Column("input_key", sa.String(64), nullable=True),
        sa.Column("attempts", sa.SmallInteger, nullable=False, server_default="0"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("state IN ('done', 'failed', 'skipped')", name="ck_photo_understanding_state"),
    )
    op.create_index("ix_photo_understanding_stage", "photo_understanding", ["stage", "version"])


def downgrade() -> None:
    op.drop_index("ix_photo_understanding_stage", table_name="photo_understanding")
    op.drop_table("photo_understanding")
    op.drop_index("ix_photo_assets_place", table_name="photo_assets")
    for col in ("quality", "brightness", "sharpness", "phash", "place_id"):
        op.drop_column("photo_assets", col)
    op.drop_table("geo_countries")
    op.drop_table("geo_admin1")
    op.drop_index("ix_geo_places_lat", table_name="geo_places")
    op.drop_table("geo_places")

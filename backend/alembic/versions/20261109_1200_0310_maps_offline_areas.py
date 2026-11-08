"""P Maps: offline areas people keep on their phones.

Revision ID: 0310_maps_offline_areas
Revises: 0292_forms_cal
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0310_maps_offline_areas"
down_revision = "0292_forms_cal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "map_offline_areas",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("west", sa.Float(), nullable=False),
        sa.Column("south", sa.Float(), nullable=False),
        sa.Column("east", sa.Float(), nullable=False),
        sa.Column("north", sa.Float(), nullable=False),
        sa.Column("shape", sa.Text(), nullable=True),
        sa.Column("cells", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("with_addresses", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("devices", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('view', 'route', 'around')", name="ck_map_offline_areas_kind"),
    )
    op.create_index("ix_map_offline_areas_user_id", "map_offline_areas", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_map_offline_areas_user_id", table_name="map_offline_areas")
    op.drop_table("map_offline_areas")

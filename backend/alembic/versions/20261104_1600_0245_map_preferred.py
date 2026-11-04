"""P Maps: the way you prefer to go between two places.

Revision ID: 0245_map_preferred
Revises: 0244_map_traffic_key
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0245_map_preferred"
down_revision = "0244_map_traffic_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "map_preferred_routes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("from_name", sa.String(200), nullable=False),
        sa.Column("from_lat", sa.Float(), nullable=False),
        sa.Column("from_lon", sa.Float(), nullable=False),
        sa.Column("to_name", sa.String(200), nullable=False),
        sa.Column("to_lat", sa.Float(), nullable=False),
        sa.Column("to_lon", sa.Float(), nullable=False),
        sa.Column("through", JSONB(), nullable=False),
        sa.Column("tolerance_minutes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("map_preferred_routes")

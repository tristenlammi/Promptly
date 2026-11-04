"""A saved place's own icon and colour.

Revision ID: 0243_map_place_icon
Revises: 0242_maps
"""
import sqlalchemy as sa
from alembic import op

revision = "0243_map_place_icon"
down_revision = "0242_maps"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("map_places", sa.Column("icon", sa.String(24)))
    op.add_column("map_places", sa.Column("colour", sa.String(9)))


def downgrade() -> None:
    op.drop_column("map_places", "colour")
    op.drop_column("map_places", "icon")

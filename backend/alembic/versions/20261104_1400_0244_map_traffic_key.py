"""The admin's live traffic key for P Maps (encrypted at rest).

Revision ID: 0244_map_traffic_key
Revises: 0243_map_place_icon
"""
import sqlalchemy as sa
from alembic import op

revision = "0244_map_traffic_key"
down_revision = "0243_map_place_icon"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_settings", sa.Column("maps_traffic_key_encrypted", sa.Text()))


def downgrade() -> None:
    op.drop_column("app_settings", "maps_traffic_key_encrypted")

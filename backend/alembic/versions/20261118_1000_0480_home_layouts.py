"""Home: each person's own layout of a home's page.

``home_layouts``: one row per person per home, the widgets they chose (ids,
order, sizes). No row means the page as it comes, so nobody's page changes
until they customise it.

Revision ID: 0480_home_layouts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0480_home_layouts"
down_revision = "0477_home_box_wipe"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "home_layouts",
        sa.Column("home_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("homes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("widgets", postgresql.JSONB(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_home_layouts_user_id", "home_layouts", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_home_layouts_user_id", table_name="home_layouts")
    op.drop_table("home_layouts")

"""Home automations: an automation can belong to a home, and has phrases.

``tasks.home_id``: the home this automation is for. Its steps switch that
home's devices; the home's owner makes and changes it, and anyone in the
home can run it (the Home page, or saying one of its phrases). Deleted with
the home. NULL for every other automation.

``tasks.phrases``: what someone says or types to run it ("it's morning
time"). Only home automations use it.

Revision ID: 0482_home_auto
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0482_home_auto"
down_revision = "0490_room_att_removed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("home_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("homes.id", ondelete="CASCADE"), nullable=True))
    op.create_index("ix_tasks_home_id", "tasks", ["home_id"])
    op.add_column("tasks", sa.Column("phrases", postgresql.JSONB(), nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("tasks", "phrases")
    op.drop_index("ix_tasks_home_id", table_name="tasks")
    op.drop_column("tasks", "home_id")

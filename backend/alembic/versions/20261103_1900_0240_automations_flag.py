"""Automations off by default: ``users.can_use_automations``. Anyone who
already owns an automation keeps them on, so nothing that runs today stops;
everyone else starts off until an admin turns it on.

Revision ID: 0240_automations_flag
Revises: 0239_tasks_default
"""
import sqlalchemy as sa
from alembic import op

revision = "0240_automations_flag"
down_revision = "0239_tasks_default"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("can_use_automations", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.execute(
        "UPDATE users SET can_use_automations = true "
        "WHERE id IN (SELECT DISTINCT user_id FROM tasks)"
    )


def downgrade() -> None:
    op.drop_column("users", "can_use_automations")

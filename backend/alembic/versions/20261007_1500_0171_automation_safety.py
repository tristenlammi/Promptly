"""Automation safety (WP-0.3): private-network permission, credential hosts.

* ``users.can_reach_private_network`` — an automation HTTP step may reach
  addresses on your own network only if its owner is an admin or has this
  permission. Any user could tick the box before (R-008, R-015).
* ``user_secrets.allowed_hosts`` — optional list of hosts a credential may
  be sent to; empty means any (R-005).

Revision ID: 0171_automation_safety
Revises: 0170_backup_runs
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0171_automation_safety"
down_revision = "0170_backup_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "can_reach_private_network",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "user_secrets",
        sa.Column(
            "allowed_hosts",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("user_secrets", "allowed_hosts")
    op.drop_column("users", "can_reach_private_network")

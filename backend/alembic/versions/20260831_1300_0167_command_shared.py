"""Share a command with everyone on the instance.

Read-only for the recipients. Safe because the capability rule re-checks
the *target* against whoever is running, so this shares a phrasing, not
access — someone else's "run the backup flow" still fails for them.

Instance-wide rather than a share table: the requirement is "everyone
can say goodnight", not a permissions system.

Revision ID: 0167_command_shared
Revises: 0166_command_runs
"""
from alembic import op
import sqlalchemy as sa

revision = "0167_command_shared"
down_revision = "0166_command_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "commands",
        sa.Column(
            "shared",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index("ix_commands_shared", "commands", ["shared"])


def downgrade() -> None:
    op.drop_index("ix_commands_shared", table_name="commands")
    op.drop_column("commands", "shared")

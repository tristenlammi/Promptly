"""Per-command "ask before running" flag.

Replaces a blanket rule — confirm every side-effecting command — with a
per-command choice, off by default. The risk isn't uniform: a dialog on
every light toggle teaches people to dismiss dialogs, which is worse than
no dialog at all on the one command where it mattered.

Off by default is a deliberate loosening for existing rows. Nothing has
shipped that relied on the old behaviour (the command library is
unreleased), and the flag governs typed and spoken runs alike so a
command can't ask in one place and not the other.

Revision ID: 0165_command_confirm
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0165_command_confirm"
down_revision = "0164_drop_saved_prompts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "commands",
        sa.Column(
            "confirm_before_run",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("commands", "confirm_before_run")

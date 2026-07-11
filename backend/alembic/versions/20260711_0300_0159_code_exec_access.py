"""Per-user code-execution access.

Adds a ``can_execute_code`` flag to ``users`` gating the user-facing "Run"
affordance on code artifacts (``POST /api/code/run``). Defaults to TRUE so
existing users can run code on deploy; admins opt individuals out. Independent
of the model-driven ``code_interpreter`` chat tool.

Revision ID: 0159_code_exec_access
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0159_code_exec_access"
down_revision = "0158_remove_study"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "can_execute_code",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "can_execute_code")

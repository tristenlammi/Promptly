"""Drop ``users.can_execute_code``: running code is gone.

The flag gated the Run button on code artifacts (``POST /api/code/run``).
That endpoint, the ``code_interpreter`` chat tool and the sandbox container
were all removed, so nothing reads it any more.

Revision ID: 0420_drop_code_exec
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0420_drop_code_exec"
down_revision = "0396_porch_group_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("users", "can_execute_code")


def downgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "can_execute_code",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )

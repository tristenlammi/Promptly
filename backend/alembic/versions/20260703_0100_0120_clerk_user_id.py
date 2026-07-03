"""Link users to Clerk identities (reversible Clerk auth migration).

Adds ``users.clerk_user_id`` — the external Clerk user id when
``AUTH_PROVIDER="clerk"``. NULL for built-in password accounts. Unique so a
Clerk user maps to exactly one local shadow row. The local row keeps owning all
app-specific state (role, allowed_models, quotas, future org membership); Clerk
owns only authentication.

Revision ID: 0120_clerk_user_id
Revises: 0119_automation_memory
Create Date: 2026-07-03 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0120_clerk_user_id"
down_revision: Union[str, Sequence[str], None] = "0119_automation_memory"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("clerk_user_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_users_clerk_user_id", "users", ["clerk_user_id"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_users_clerk_user_id", table_name="users")
    op.drop_column("users", "clerk_user_id")

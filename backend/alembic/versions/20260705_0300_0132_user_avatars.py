"""User avatars: profile picture timestamp + custom initials colour.

``avatar_updated_at`` doubles as the "has an avatar" flag (NULL = none)
and the cache-buster version in signed avatar URLs. ``avatar_color`` is
the user-chosen initials-chip colour (NULL = deterministic palette hash,
same as collab cursors).

Revision ID: 0132_user_avatars
Revises: 0131_ws_intel
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0132_user_avatars"
down_revision: Union[str, Sequence[str], None] = "0131_ws_intel"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users", sa.Column("avatar_color", sa.String(length=16), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "avatar_color")
    op.drop_column("users", "avatar_updated_at")

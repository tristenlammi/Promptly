"""Workspace Drive (Phase 6-7): optional per-workspace storage cap.

``workspaces.storage_quota_bytes`` caps the combined size of the files
pinned to a workspace (its "drive"). NULL = unlimited (the default —
the owner's personal storage quota still applies to every byte, since
workspace files are stored in the owner's bucket).

Revision ID: 0129_ws_drive_quota
Revises: 0128_drop_org
Create Date: 2026-07-04 09:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0129_ws_drive_quota"
down_revision: Union[str, Sequence[str], None] = "0128_drop_org"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column("storage_quota_bytes", sa.BigInteger(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workspaces", "storage_quota_bytes")

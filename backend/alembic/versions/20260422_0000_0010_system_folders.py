"""System folders for auto-routing chat uploads + future generated files.

Schema delta:

* ``file_folders.system_kind`` — new nullable ``VARCHAR(64)`` column. ``NULL``
  means the folder is a regular user-created folder. A non-NULL value marks
  the folder as system-managed (created automatically, un-renameable,
  un-deletable). Permitted values are tracked in
  ``app.files.system_folders.SystemKind``.

* Partial unique index on ``(user_id, system_kind)`` where
  ``system_kind IS NOT NULL`` — guarantees we never end up with two
  ``Chat Uploads`` (or two ``Generated Files``) folders for the same user
  even under concurrent first-time uploads.

The existing tree of regular folders is untouched; system folders are
created lazily on first use rather than back-filled here.

Revision ID: 0010_system_folders
Revises: 0009_phase3_quotas
Create Date: 2026-04-22 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010_system_folders"
down_revision: Union[str, Sequence[str], None] = "0009_phase3_quotas"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "file_folders",
        sa.Column("system_kind", sa.String(length=64), nullable=True),
    )
    # Partial unique index — there can only be one system folder of each
    # kind per user. Postgres treats two NULLs as distinct, so the
    # WHERE clause is what actually enforces "exactly one" semantics.
    op.create_index(
        "ux_file_folders_user_system_kind",
        "file_folders",
        ["user_id", "system_kind"],
        unique=True,
        postgresql_where=sa.text("system_kind IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ux_file_folders_user_system_kind", table_name="file_folders")
    op.drop_column("file_folders", "system_kind")

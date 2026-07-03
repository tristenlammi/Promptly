"""deletion grace: soft-delete clocks on users + organizations

Adds a nullable ``deleted_at`` to ``users`` and ``organizations`` so a Clerk
deletion marks the row (recoverable during a grace window) instead of instantly
destroying it / cascading it away. A scheduled purge job hard-deletes rows whose
``deleted_at`` is older than ``DELETION_GRACE_DAYS``.

Revision ID: 0127_deletion_grace
Revises: 0126_org_model_defaults
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0127_deletion_grace"
down_revision: Union[str, Sequence[str], None] = "0126_org_model_defaults"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "organizations",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Partial indexes: the purge job only ever scans the (tiny) soft-deleted set.
    op.create_index(
        "ix_users_deleted_at",
        "users",
        ["deleted_at"],
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
    )
    op.create_index(
        "ix_organizations_deleted_at",
        "organizations",
        ["deleted_at"],
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_organizations_deleted_at", table_name="organizations")
    op.drop_index("ix_users_deleted_at", table_name="users")
    op.drop_column("organizations", "deleted_at")
    op.drop_column("users", "deleted_at")

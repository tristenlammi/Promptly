"""Search-provider ordering + auto-backoff.

Adds an explicit priority order the admin arranges (``position``, lower = tried
first) plus a persistent auto-pause so a provider that fails with a hard error
(auth/quota) is sidelined for a while instead of being hammered on every
search: ``cooldown_until`` (skip until this time) + ``last_error`` (surfaced to
the admin). Persistent because the backend + arq-worker are separate processes
and a restart mustn't forget the pause.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0153_search_provider_backoff"
down_revision = "0152_oidc_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "search_providers",
        sa.Column(
            "position",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "search_providers",
        sa.Column("cooldown_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "search_providers",
        sa.Column("last_error", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("search_providers", "last_error")
    op.drop_column("search_providers", "cooldown_until")
    op.drop_column("search_providers", "position")

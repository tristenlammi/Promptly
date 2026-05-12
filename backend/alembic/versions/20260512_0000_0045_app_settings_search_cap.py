"""App settings — admin-tunable per-turn cap on ``web_search`` calls.

The chat router enforces a per-tool cap on how many ``web_search``
invocations a single assistant turn can fire (was hardcoded to 3 on
the :class:`WebSearchTool` class). With realistic prompts a model
will often want to refine a query 2-3 times *plus* make a couple of
sibling searches for unrelated facets of the same question, which
makes 3 feel tight in practice and produces a wall of red "Web
search failed" chips for the user every time it overshoots.

Promoting the cap to a column on ``app_settings`` lets admins tune
it per deployment without redeploying, and aligns the new default
(5) with :data:`MAX_TOOL_HOPS` so the per-tool cap and the global
hop limit hit at the same point — neither is the obvious binding
constraint by accident.

Naming note: the revision id is deliberately kept short
(``0045_app_settings_search_cap`` — 28 chars) so it fits inside
``alembic_version.version_num``'s ``varchar(32)`` column.
``0040_app_settings_origins_vapid`` (31 chars) is the precedent
for the limit; longer ids fail to UPDATE during the migration run
itself.

Revision ID: 0045_app_settings_search_cap
Revises: 0044_fix_fts_filename_hyphens
Create Date: 2026-05-12 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0045_app_settings_search_cap"
down_revision: Union[str, None] = "0044_fix_fts_filename_hyphens"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "chat_max_web_searches_per_turn",
            sa.Integer(),
            nullable=False,
            # ``server_default`` so existing deploys pick up "5" without
            # the migration having to run any UPDATE. The Python-side
            # ``default`` on the ORM stays in sync for newly-created
            # rows (a fresh install before the singleton exists).
            server_default=sa.text("5"),
        ),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "chat_max_web_searches_per_turn")

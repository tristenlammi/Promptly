"""Replace ``conversations.web_search`` boolean with ``web_search_mode`` enum.

Phase D1 widens the per-chat web search switch from on/off to a three-mode
preference: ``off``, ``auto`` (model decides via the ``web_search`` tool),
and ``always`` (forced search before every reply, today's "on"
behaviour). Storing it as a short ``VARCHAR(8)`` instead of a Postgres
ENUM keeps schema migrations cheap if we ever want to add a fourth mode
(e.g. ``"deep"`` for multi-step research) without DDL acrobatics.

Backfill: ``True`` → ``"always"`` (preserves current user behaviour),
``False`` → ``"off"``. The user-level preference key
``default_web_search`` is renamed to ``default_web_search_mode`` in
``users.settings`` (JSONB) by the same migration so per-user defaults
survive.

Revision ID: 0013_web_search_mode
Revises: 0012_file_source_link
Create Date: 2026-04-25 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_web_search_mode"
down_revision: Union[str, Sequence[str], None] = "0012_file_source_link"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ---- conversations.web_search -> web_search_mode ----
    # Add the new column nullable so the backfill UPDATE has somewhere
    # to write before we tighten the constraint.
    op.add_column(
        "conversations",
        sa.Column("web_search_mode", sa.String(length=8), nullable=True),
    )
    op.execute(
        "UPDATE conversations "
        "SET web_search_mode = CASE WHEN web_search THEN 'always' ELSE 'off' END"
    )
    op.alter_column(
        "conversations",
        "web_search_mode",
        existing_type=sa.String(length=8),
        nullable=False,
        server_default="off",
    )
    # Drop the legacy boolean — every code path is migrated in this
    # release, no need to keep both columns.
    op.drop_column("conversations", "web_search")

    # ---- users.settings.default_web_search -> default_web_search_mode ----
    # JSONB rewrite. Preserves the existing on/off intent: True users
    # were happy paying per turn, so they get "always"; False users were
    # explicitly off, so they get "off". Anyone with no key set keeps
    # the JSONB-level absence and picks up the runtime default ("auto").
    op.execute(
        """
        UPDATE users
        SET settings = (settings - 'default_web_search')
                       || jsonb_build_object(
                           'default_web_search_mode',
                           CASE WHEN (settings->>'default_web_search')::boolean
                                THEN 'always'
                                ELSE 'off'
                           END
                       )
        WHERE settings ? 'default_web_search'
        """
    )


def downgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "web_search",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.execute(
        "UPDATE conversations SET web_search = (web_search_mode = 'always')"
    )
    op.drop_column("conversations", "web_search_mode")

    op.execute(
        """
        UPDATE users
        SET settings = (settings - 'default_web_search_mode')
                       || jsonb_build_object(
                           'default_web_search',
                           settings->>'default_web_search_mode' = 'always'
                       )
        WHERE settings ? 'default_web_search_mode'
        """
    )

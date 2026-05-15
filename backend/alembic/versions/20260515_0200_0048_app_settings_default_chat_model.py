"""App settings — global default chat model.

Adds a (provider_id, model_id) pair to ``app_settings`` that any
brand-new conversation falls back to when the creating user has no
personal default set on their own account. Three-step precedence
the chat router enforces:

1. User's personal default (``users.default_provider_id`` /
   ``users.default_model_id``) — explicit preference, never
   overridden.
2. **Admin default** (these new columns) — workspace-wide nudge
   towards a sensible starting model for fresh users / fresh chats.
3. First available model from the catalog — historic fallback,
   unchanged.

* ``default_chat_provider_id`` — FK to ``model_providers``,
  ``ON DELETE SET NULL`` so deleting the underlying provider
  cleanly disables the default instead of orphaning a dangling id.
* ``default_chat_model_id``    — free-form catalog id (varchar 255),
  matching the shape of ``vision_relay_model_id`` / personal-
  default ids on ``users``.

Revision ID note: ``0048_app_settings_default_chat_model`` is 36
chars — over the ``alembic_version.version_num varchar(32)``
limit that caught us on 0045. Shortened to ``0048_appsettings_defchat``
(24 chars).

Revision ID: 0048_appsettings_defchat
Revises: 0047_appsettings_vrelay
Create Date: 2026-05-15 02:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0048_appsettings_defchat"
down_revision: Union[str, None] = "0047_appsettings_vrelay"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "default_chat_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column(
            "default_chat_model_id",
            sa.String(length=255),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "default_chat_model_id")
    op.drop_column("app_settings", "default_chat_provider_id")

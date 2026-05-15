"""App settings — vision relay model.

Adds two columns to ``app_settings`` that let an admin designate a
vision-capable model used to caption images for non-vision chat
models. When a user attaches an image to a chat whose active model
can't read images, the chat router routes each image through this
relay model first, splices the resulting text caption into the
prompt, and emits a chip pair (``vision_relay_started`` /
``vision_relay_finished``) so the user sees what happened.

* ``vision_relay_provider_id`` — FK to ``model_providers``; ON DELETE
  SET NULL so deleting the underlying provider cleanly disables the
  feature instead of orphaning a dangling id. NULL = feature off.
* ``vision_relay_model_id``    — free-form string (varchar 255) so it
  can hold an arbitrary catalog id (``gpt-4o-mini``, ``gemini-flash``,
  ``custom:<uuid>``, etc.) without an FK constraint we can't easily
  cascade across the curated-models JSONB column.

Naming note: revision id ``0047_app_settings_vision_relay`` is 33
chars — just over the ``alembic_version.version_num varchar(32)``
limit that bit us on 0045. Shortened to ``0047_appsettings_vrelay``
(24 chars) to stay safely under.

Revision ID: 0047_appsettings_vrelay
Revises: 0046_conv_reasoning_effort
Create Date: 2026-05-15 01:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0047_appsettings_vrelay"
down_revision: Union[str, None] = "0046_conv_reasoning_effort"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "vision_relay_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column(
            "vision_relay_model_id",
            sa.String(length=255),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "vision_relay_model_id")
    op.drop_column("app_settings", "vision_relay_provider_id")

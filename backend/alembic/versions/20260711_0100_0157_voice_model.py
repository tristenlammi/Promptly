"""Dedicated voice model (admin default).

Adds an admin-selected model used for real-time voice-mode turns
(``app_settings.voice_*``), mirroring the vision-relay / image-gen pairs.
Real-time voice wants the fastest model, not necessarily the chat model —
this lets an admin pin a low-latency model for spoken turns.

Revision ID: 0157_voice_model
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0157_voice_model"
down_revision = "0156_image_gen_access"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column(
            "voice_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("voice_model_id", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "voice_model_id")
    op.drop_column("app_settings", "voice_provider_id")

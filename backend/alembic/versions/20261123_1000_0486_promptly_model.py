"""The built-in "Promptly" custom model.

Every install gets one custom model called Promptly (made at start-up by
``app/custom_models/builtin.py``, once). On a fresh install nobody has
connected an AI service yet, so it has no model behind it until an admin
picks one:

* ``custom_models.base_provider_id`` / ``base_model_id`` may be NULL: a
  custom model with no model behind it is "not ready".
* ``app_settings.builtin_model_id`` — which custom model is the built-in
  one (no foreign key: deleting it just leaves a stale id nobody matches).
* ``app_settings.builtin_model_seeded`` — it was made once; never again,
  even if an admin renames or deletes it.

Revision ID: 0486_promptly_model
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0486_promptly_model"
down_revision = "0485_study_three"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("custom_models", "base_provider_id", existing_type=postgresql.UUID(as_uuid=True), nullable=True)
    op.alter_column("custom_models", "base_model_id", existing_type=sa.String(128), nullable=True)
    op.add_column("app_settings", sa.Column("builtin_model_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column(
        "app_settings",
        sa.Column("builtin_model_seeded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "builtin_model_seeded")
    op.drop_column("app_settings", "builtin_model_id")
    # A custom model with nothing behind it can't exist in the old shape.
    op.execute("DELETE FROM custom_models WHERE base_provider_id IS NULL OR base_model_id IS NULL")
    op.alter_column("custom_models", "base_model_id", existing_type=sa.String(128), nullable=False)
    op.alter_column("custom_models", "base_provider_id", existing_type=postgresql.UUID(as_uuid=True), nullable=False)

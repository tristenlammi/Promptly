"""Image-generation defaults + per-user access.

Adds the admin-selected default image-generation model to ``app_settings``
(mirrors the ``vision_relay_*`` / ``default_chat_*`` pairs), and a per-user
``can_generate_images`` flag to ``users``. The flag defaults to TRUE so
existing users keep image generation on deploy; admins opt individuals out.

Revision ID: 0156_image_gen_access
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0156_image_gen_access"
down_revision = "0155_data_views"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ----- app_settings: admin-selected default image-gen model -----
    op.add_column(
        "app_settings",
        sa.Column(
            "image_gen_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("image_gen_model_id", sa.String(length=255), nullable=True),
    )

    # ----- users: per-user image-generation access (default ON) -----
    op.add_column(
        "users",
        sa.Column(
            "can_generate_images",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "can_generate_images")
    op.drop_column("app_settings", "image_gen_model_id")
    op.drop_column("app_settings", "image_gen_provider_id")

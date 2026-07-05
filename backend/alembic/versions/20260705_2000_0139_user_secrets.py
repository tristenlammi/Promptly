"""Credentials vault for automations (A1).

``user_secrets`` — named, Fernet-encrypted values a user's automations
reference as ``{{secret.NAME}}`` (resolved only inside the HTTP-request
node at execution time, and redacted from every recorded surface). The
value is never returned by any API after creation.

Revision ID: 0139_user_secrets
Revises: 0138_trash_fields
Create Date: 2026-07-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0139_user_secrets"
down_revision: Union[str, Sequence[str], None] = "0138_trash_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_secrets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("value_encrypted", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_user_secrets_name"),
    )
    op.create_index("ix_user_secrets_user_id", "user_secrets", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_user_secrets_user_id", table_name="user_secrets")
    op.drop_table("user_secrets")

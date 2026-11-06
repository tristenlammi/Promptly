"""Passwords: a key change owed after someone leaves, and the session a connect approval is tied to.

Revision ID: 0255_passwords_hardening
Revises: 0254_passwords_core
"""
import sqlalchemy as sa
from alembic import op

revision = "0255_passwords_hardening"
down_revision = "0254_passwords_core"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pw_vaults", sa.Column("rotate_needed", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("pw_connects", sa.Column("token_version", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("pw_connects", "token_version")
    op.drop_column("pw_vaults", "rotate_needed")

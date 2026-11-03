"""Lock a member to their one model: ``users.model_locked``. When on, the
member's own ``allowed_models`` is the whole allow-set (groups can't widen
it) and the chat picker shows the model's name with no dropdown.

Revision ID: 0241_model_locked
Revises: 0240_automations_flag
"""
import sqlalchemy as sa
from alembic import op

revision = "0241_model_locked"
down_revision = "0240_automations_flag"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("model_locked", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("users", "model_locked")

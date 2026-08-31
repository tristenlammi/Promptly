"""Drop ``saved_prompts`` — the command library carries them now.

Revision 0162 *copied* every saved prompt into ``commands`` as an
``action_type='prompt'`` row and deliberately left this table in place as
a safety net while the new one proved itself. Nothing has read or written
it since: the ``/`` menu, the Prompts tab, and the API all go through
``commands``.

The downgrade re-creates the table and copies the prompt-type commands
back into it, so rolling back doesn't lose anything a user wrote after
the switch.

Revision ID: 0164_drop_saved_prompts
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0164_drop_saved_prompts"
down_revision = "0163_mcp_transport"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("saved_prompts")


def downgrade() -> None:
    op.create_table(
        "saved_prompts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_saved_prompts_user_id", "saved_prompts", ["user_id"])
    # Carry the prompts back, so a rollback doesn't strand anything
    # written since the switch.
    op.execute(
        """
        INSERT INTO saved_prompts (
            id, user_id, title, body, created_at, updated_at
        )
        SELECT gen_random_uuid(), user_id, name, coalesce(body, ''),
               created_at, updated_at
        FROM commands
        WHERE action_type = 'prompt'
        """
    )

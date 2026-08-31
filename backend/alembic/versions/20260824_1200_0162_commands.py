"""Command library — saved prompts and voice/chat commands in one table.

A saved prompt and a voice command are the same object with different
action types, so they live in one table behind one matcher and one ``/``
menu. This creates ``commands`` and **copies** every ``saved_prompts``
row into it as an ``action_type='prompt'`` command.

Deliberately a copy, not a move: ``saved_prompts`` is left in place and
untouched so this migration is reversible without data loss and so a
rollback doesn't strand anyone's templates. A later revision drops it
once the new table has proven itself.

Revision ID: 0162_commands
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0162_commands"
down_revision = "0161_discussions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "commands",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column(
            "phrases",
            postgresql.ARRAY(sa.String(120)),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "action_type",
            sa.String(16),
            nullable=False,
            server_default="prompt",
        ),
        sa.Column("action_ref", sa.String(255), nullable=True),
        sa.Column(
            "action_args",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("response_template", sa.String(280), nullable=True),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default="true"
        ),
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
    op.create_index("ix_commands_user_id", "commands", ["user_id"])
    op.create_index(
        "ix_commands_user_action", "commands", ["user_id", "action_type"]
    )

    # Backfill. ``phrases`` stays EMPTY on purpose: an existing saved
    # prompt was only ever picked from a menu, and silently making its
    # title a spoken trigger would let an unrelated turn of phrase fire
    # someone's template. Users opt phrases in per command.
    op.execute(
        """
        INSERT INTO commands (
            id, user_id, name, phrases, action_type, action_args,
            body, enabled, created_at, updated_at
        )
        SELECT
            gen_random_uuid(), user_id, title, '{}', 'prompt', '{}',
            body, true, created_at, updated_at
        FROM saved_prompts
        """
    )


def downgrade() -> None:
    # ``saved_prompts`` was never modified, so dropping this table loses
    # only commands created after the upgrade.
    op.drop_index("ix_commands_user_action", table_name="commands")
    op.drop_index("ix_commands_user_id", table_name="commands")
    op.drop_table("commands")

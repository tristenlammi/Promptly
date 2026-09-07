"""Command run history.

The matcher refuses to guess, which means a miss is silent by design.
This table is the other half of that bargain: whatever did run, you can
look up afterwards instead of relying on having heard the reply.

``command_id`` is SET NULL rather than CASCADE — deleting a command
shouldn't rewrite the past, so the name is copied onto the row.

Revision ID: 0166_command_runs
Revises: 0165_command_confirm
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0166_command_runs"
down_revision = "0165_command_confirm"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "command_runs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "command_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("commands.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("command_name", sa.String(120), nullable=False),
        sa.Column(
            "source",
            sa.String(16),
            nullable=False,
            server_default="chat",
        ),
        sa.Column(
            "ok", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column("utterance", sa.String(500), nullable=True),
        sa.Column(
            "slots",
            postgresql.JSONB(),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("detail", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_command_runs_user_id", "command_runs", ["user_id"]
    )
    op.create_index(
        "ix_command_runs_user_created",
        "command_runs",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_command_runs_user_created", table_name="command_runs")
    op.drop_index("ix_command_runs_user_id", table_name="command_runs")
    op.drop_table("command_runs")

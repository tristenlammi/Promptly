"""Memory facts get a life: when they were true, when they stop, what they used to say,
where they apply, and a short profile written from them.

A fact is no longer deleted when it stops being true. It's retired, with when and why,
so "where did I used to work?" still has an answer and a wrong guess can be put back.
Chats already here count as read: nothing is sent to a model for them unless you ask.

Revision ID: 0255_memory_lifecycle
Revises: 0253_mail_folder_labels
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0255_memory_lifecycle"
down_revision = "0253_mail_folder_labels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # active | retired | suggested | dismissed
    op.add_column("user_memories", sa.Column("status", sa.String(16), nullable=False, server_default="active"))
    op.add_column("user_memories", sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column("user_memories", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("user_memories", sa.Column("retired_reason", sa.String(24), nullable=True))
    op.add_column("user_memories", sa.Column("superseded_by", UUID(as_uuid=True), sa.ForeignKey("user_memories.id", ondelete="SET NULL"), nullable=True))
    op.add_column("user_memories", sa.Column("workspace_id", UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True))
    # Where a suggestion came from: {"kind": "mail", "id": ..., "title": ...}.
    op.add_column("user_memories", sa.Column("source_ref", JSONB, nullable=True))
    # Learned in the background and not mentioned to you yet.
    op.add_column("user_memories", sa.Column("unannounced", sa.Boolean, nullable=False, server_default=sa.false()))
    op.create_index("ix_user_memories_user_status", "user_memories", ["user_id", "status"])

    op.create_table(
        "user_memory_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("memory_id", UUID(as_uuid=True), sa.ForeignKey("user_memories.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("category", sa.String(20), nullable=True),
        # Until when it said this: the moment it changed.
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        # user | chat | capture | upkeep
        sa.Column("changed_by", sa.String(16), nullable=False, server_default="user"),
    )

    op.create_table(
        "user_memory_profiles",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("content", sa.Text, nullable=False),
        # Which facts it was written from: no change, no new model call.
        sa.Column("fingerprint", sa.String(32), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        # What each fact said when this was written, to notice one that has since gone.
        sa.Column("source_hashes", JSONB, nullable=False, server_default="{}"),
    )

    # How far the background pass has read. Empty means "not yet".
    op.add_column("conversations", sa.Column("memory_captured_through", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE conversations SET memory_captured_through = now(), updated_at = updated_at")
    # Nothing up to here may ever reach memory: said while paused, while temporary, or
    # copied from another chat. Reading older chats again doesn't go back past it.
    op.add_column("conversations", sa.Column("memory_private_until", sa.DateTime(timezone=True), nullable=True))
    # The reply drew on outside content, so what it says isn't evidence about you.
    op.add_column("messages", sa.Column("read_outside_content", sa.Boolean, nullable=False, server_default=sa.false()))


def downgrade() -> None:
    # The older code would treat every row as a fact, including ones never approved.
    op.execute("DELETE FROM user_memories WHERE status <> 'active'")
    op.drop_column("messages", "read_outside_content")
    op.drop_column("conversations", "memory_private_until")
    op.drop_column("conversations", "memory_captured_through")
    op.drop_table("user_memory_profiles")
    op.drop_table("user_memory_versions")
    op.drop_index("ix_user_memories_user_status", table_name="user_memories")
    for column in ("unannounced", "source_ref", "workspace_id", "superseded_by", "retired_reason", "expires_at", "valid_until", "status"):
        op.drop_column("user_memories", column)

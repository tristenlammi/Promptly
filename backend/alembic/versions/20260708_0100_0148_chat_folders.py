"""Personal chat folders.

* ``chat_folders`` — a user-created folder grouping personal chats in the
  sidebar, with a live default system prompt + default model.
* ``conversations.folder_id`` — nullable FK (SET NULL) placing a chat in a
  folder. Deleting a folder lifts its chats back to top-level.

Revision ID: 0148_chat_folders
Revises: 0147_memory_model
Create Date: 2026-07-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0148_chat_folders"
down_revision: Union[str, Sequence[str], None] = "0147_memory_model"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "chat_folders",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=True),
        sa.Column("default_model_id", sa.String(255), nullable=True),
        sa.Column(
            "default_provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("model_providers.id", ondelete="SET NULL"),
            nullable=True,
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
    op.create_index(
        "ix_chat_folders_user_id", "chat_folders", ["user_id"]
    )

    op.add_column(
        "conversations",
        sa.Column(
            "folder_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("chat_folders.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_conversations_folder_id", "conversations", ["folder_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_folder_id", table_name="conversations")
    op.drop_column("conversations", "folder_id")
    op.drop_index("ix_chat_folders_user_id", table_name="chat_folders")
    op.drop_table("chat_folders")

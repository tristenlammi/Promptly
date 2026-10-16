"""Imported chats remember where they came from (R-309).

A retried import used to create a second (and third) copy of a whole
ChatGPT history. ``import_source_key`` ("chatgpt:<id>", "claude:<uuid>",
"promptly:<id>", "markdown:<hash>") lets the importer skip what already
came in.

Revision ID: 0187_conv_import_source_key
Revises: 0186_embed_model_fingerprint
"""
from alembic import op
import sqlalchemy as sa

revision = "0187_conv_import_source_key"
down_revision = "0186_embed_model_fingerprint"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("import_source_key", sa.String(160), nullable=True),
    )
    op.create_index(
        "ix_conversations_user_import_source_key",
        "conversations",
        ["user_id", "import_source_key"],
        postgresql_where=sa.text("import_source_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_user_import_source_key", table_name="conversations")
    op.drop_column("conversations", "import_source_key")

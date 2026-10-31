"""The Item Store: small apps whose whole state lives in one file.

* ``item_documents`` — an item file's content (validated JSON + revision);
  its ``files`` row is a shell (``source_kind='item'``).
* ``item_installs`` — the items each person added (nothing on by default).
* ``item_reminders`` — upcoming nudges an item asked for.
* ``item_state`` — server-only state beside a file (sync cursors, an
  encrypted token, the AI panel's thread).
* ``file_versions.kind`` gains ``item``; ``push_preferences.item_reminder``;
  ``app_settings.disabled_items``.

Revision ID: 0229_item_store
Revises: 0228_photo_deleted_hashes
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0229_item_store"
down_revision = "0228_photo_deleted_hashes"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "item_documents",
        sa.Column("file_id", _UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("kind", sa.String(48), nullable=False),
        sa.Column("schema_version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("revision", sa.Integer, nullable=False, server_default="1"),
        sa.Column("data", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("updated_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("periodic_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("workspace_id", _UUID, nullable=True),
    )
    op.create_index("ix_item_documents_kind", "item_documents", ["kind"])

    op.create_table(
        "item_installs",
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("kind", sa.String(48), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "item_reminders",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("file_id", _UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(200), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text, nullable=False, server_default=""),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_item_reminders_file_id", "item_reminders", ["file_id"])
    op.create_index("ix_item_reminders_due_at", "item_reminders", ["due_at"])
    op.create_index(
        "ix_item_reminders_unsent", "item_reminders", ["due_at"], postgresql_where=sa.text("sent_at IS NULL")
    )

    op.create_table(
        "item_state",
        sa.Column("file_id", _UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("key", sa.String(120), primary_key=True),
        sa.Column("value", postgresql.JSONB, nullable=True),
        sa.Column("secret", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.drop_constraint("ck_file_versions_kind", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_kind", "file_versions", "kind IN ('document','sheet','whiteboard','pdf','blob','item')"
    )

    op.add_column(
        "push_preferences",
        sa.Column("item_reminder", sa.Boolean, nullable=False, server_default="true"),
    )
    op.add_column(
        "app_settings",
        sa.Column("disabled_items", postgresql.JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "disabled_items")
    op.drop_column("push_preferences", "item_reminder")
    op.execute("DELETE FROM file_versions WHERE kind = 'item'")
    op.drop_constraint("ck_file_versions_kind", "file_versions", type_="check")
    op.create_check_constraint(
        "ck_file_versions_kind", "file_versions", "kind IN ('document','sheet','whiteboard','pdf','blob')"
    )
    op.drop_table("item_state")
    op.drop_table("item_reminders")
    op.drop_table("item_installs")
    op.drop_index("ix_item_documents_kind", table_name="item_documents")
    op.drop_table("item_documents")

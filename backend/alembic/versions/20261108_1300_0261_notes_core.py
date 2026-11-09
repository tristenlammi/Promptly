"""Notes: notes, checklist items, sharing, per-person state, attachments,
reminders, versions, and the Notes push switch.

Revision ID: 0261_notes_core
Revises: 0301_talk_barge_ms
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0261_notes_core"
down_revision = "0301_talk_barge_ms"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB
COLORS = ("default", "coral", "peach", "sand", "mint", "sage", "fog", "storm", "dusk", "blossom", "clay", "chalk")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("owner_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False, server_default="text"),
        sa.Column("title", sa.String(300), nullable=False, server_default=""),
        sa.Column("body_doc", JSONB, nullable=True),
        sa.Column("body_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("color", sa.String(16), nullable=False, server_default="default"),
        sa.Column("list_opts", JSONB, nullable=False, server_default="{}"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("change_seq", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("edited_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source", sa.String(8), nullable=False, server_default="web"),
        sa.Column("import_ref", sa.String(200), nullable=True),
        sa.Column("doc_file_id", UUID, sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("trashed_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("search_text", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("kind IN ('text', 'list')", name="ck_notes_kind"),
        sa.CheckConstraint(_in("color", COLORS), name="ck_notes_color"),
        sa.CheckConstraint(_in("source", ("web", "android", "share", "voice", "chat", "import")), name="ck_notes_source"),
    )
    op.create_index("ix_notes_owner_updated", "notes", ["owner_id", sa.text("updated_at DESC")])
    op.create_index("ix_notes_trashed", "notes", ["trashed_at"], postgresql_where=sa.text("trashed_at IS NOT NULL"))
    op.create_index(
        "uq_notes_owner_import_ref", "notes", ["owner_id", "import_ref"], unique=True,
        postgresql_where=sa.text("import_ref IS NOT NULL"),
    )
    # Search: the title as typed (any language), the rest stemmed English and
    # as typed — the same two ways Drive search reads ``files.content_tsv``.
    op.execute(
        """
        ALTER TABLE notes ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(search_text, '')), 'B') ||
            setweight(to_tsvector('simple', coalesce(search_text, '')), 'C')
        ) STORED
        """
    )
    op.execute("CREATE INDEX ix_notes_tsv ON notes USING GIN (tsv)")

    op.create_table(
        "note_items",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("parent_id", UUID, sa.ForeignKey("note_items.id", ondelete="SET NULL"), nullable=True),
        sa.Column("text", sa.String(1000), nullable=False, server_default=""),
        sa.Column("checked", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position", sa.Float(precision=53), nullable=False, server_default="0"),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_note_items_note_position", "note_items", ["note_id", "position"])

    op.create_table(
        "note_members",
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("added_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_note_members_user_id", "note_members", ["user_id"])

    op.create_table(
        "note_user_state",
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("position", sa.Float(precision=53), nullable=False, server_default="0"),
        sa.Column("seen_seq", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_note_user_state_user_id", "note_user_state", ["user_id"])

    op.create_table(
        "note_attachments",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_id", UUID, sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("position", sa.Float(precision=53), nullable=False, server_default="0"),
        sa.Column("added_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("peaks", JSONB, nullable=True),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("transcript_state", sa.String(8), nullable=True),
        sa.Column("transcript_lang", sa.String(16), nullable=True),
        sa.Column("transcribed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('image', 'audio')", name="ck_note_attachments_kind"),
        sa.CheckConstraint(
            "transcript_state IS NULL OR transcript_state IN ('pending', 'working', 'done', 'failed', 'off')",
            name="ck_note_attachments_transcript_state",
        ),
    )
    op.create_index("ix_note_attachments_note", "note_attachments", ["note_id", "position"])
    op.create_index("ix_note_attachments_file_id", "note_attachments", ["file_id"])

    op.create_table(
        "note_reminders",
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tasks_file_id", UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("task_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_note_reminders_user_id", "note_reminders", ["user_id"])

    op.create_table(
        "note_versions",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_id", UUID, sa.ForeignKey("notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("snapshot", JSONB, nullable=False),
        sa.Column("reason", sa.String(8), nullable=False, server_default="edit"),
        sa.Column("made_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("reason IN ('edit', 'restore', 'ai')", name="ck_note_versions_reason"),
    )
    op.create_index("ix_note_versions_note_created", "note_versions", ["note_id", "created_at"])

    op.add_column("push_preferences", sa.Column("notes", sa.Boolean(), nullable=False, server_default="true"))


def downgrade() -> None:
    op.drop_column("push_preferences", "notes")
    op.execute("DELETE FROM tag_assignments WHERE entity_kind = 'note'")
    op.execute("DELETE FROM entity_links WHERE source_kind = 'note' OR target_kind = 'note'")
    for t in ("note_versions", "note_reminders", "note_attachments", "note_user_state", "note_members", "note_items"):
        op.drop_table(t)
    op.drop_table("notes")

"""Forms (WP-F1.1): a form is a Files document type.

``files`` holds the form's shell (``source_kind='form'``, no blob); the form
itself is a ``forms`` row (definition, settings, counters). Answers live in
``form_responses``; ``form_option_counts`` holds the per-option counters that
make "limit per option" safe; ``form_uploads`` stages respondents' files;
``form_notify`` is each person's notification choice per form. Also:
``push_preferences.form_response``, the admin switch
``app_settings.forms_link_answers`` (on), and ``file_share_links`` learns
``resource_type='form'`` (a form's answer link never serves the file).

Trashing a form's shell closes it, and restoring it leaves it closed: a
trigger on ``files`` does that for every trash path (single file, folder,
bulk), so no caller can forget.

Revision ID: 0290_forms_core
Revises: 0260_pw_browsersync
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0290_forms_core"
down_revision = "0260_pw_browsersync"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)

_CLOSE_FN = """
CREATE OR REPLACE FUNCTION forms_close_on_trash()
RETURNS trigger AS $$
BEGIN
    UPDATE forms SET accepting = false, updated_at = now() WHERE file_id = NEW.id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    op.create_table(
        "forms",
        sa.Column("id", _UUID, primary_key=True),
        # The shell. Never cascaded (the spreadsheets.file_id rule): purging
        # the form deletes this row first, on purpose.
        sa.Column("file_id", _UUID, sa.ForeignKey("files.id"), nullable=False, unique=True),
        sa.Column("definition", postgresql.JSONB(), nullable=False),
        sa.Column("data_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("audience", sa.String(8), nullable=False, server_default="server"),
        sa.Column("accepting", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("close_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_responses", sa.Integer(), nullable=True),
        sa.Column("one_per_person", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("allow_edit", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("collect_email", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("show_remaining", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("allow_uploads_from_link", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("confirmation", sa.Text(), nullable=False, server_default=""),
        sa.Column("closed_message", sa.Text(), nullable=False, server_default=""),
        sa.Column("allow_another", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("event_id", _UUID, sa.ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sheet_file_id", _UUID, sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sheet_tab_id", sa.String(64), nullable=True),
        sa.Column("sheet_synced_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sheet_error", sa.Text(), nullable=True),
        sa.Column("next_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("response_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_response_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("audience IN ('server','link')", name="forms_audience_check"),
        sa.CheckConstraint("max_responses IS NULL OR max_responses > 0", name="forms_max_responses_check"),
    )
    op.create_index("ix_forms_event_id", "forms", ["event_id"])
    op.create_index("ix_forms_close_at", "forms", ["close_at"], postgresql_where=sa.text("close_at IS NOT NULL"))

    # Every change to a response takes a new seq; the linked Sheet syncs
    # everything above ``forms.sheet_synced_seq``.
    op.execute("CREATE SEQUENCE form_response_seq")
    op.create_table(
        "form_responses",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("form_id", _UUID, sa.ForeignKey("forms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("respondent_id", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("email", sa.String(254), nullable=True),
        sa.Column("source", sa.String(8), nullable=False),
        sa.Column("answers", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("path", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("submit_id", _UUID, nullable=False),
        sa.Column("edit_token_hash", sa.String(64), nullable=True),
        sa.Column("score", sa.Numeric(), nullable=True),
        sa.Column("grading", postgresql.JSONB(), nullable=True),
        sa.Column("seq", sa.BigInteger(), nullable=False, server_default=sa.text("nextval('form_response_seq')")),
        sa.Column("submitted_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("form_id", "number", name="uq_form_responses_number"),
        sa.UniqueConstraint("form_id", "submit_id", name="uq_form_responses_submit_id"),
        sa.CheckConstraint("source IN ('server','link')", name="form_responses_source_check"),
    )
    op.create_index("ix_form_responses_form_submitted", "form_responses", ["form_id", "submitted_at"])
    op.create_index("ix_form_responses_form_seq", "form_responses", ["form_id", "seq"])
    op.create_index("ix_form_responses_respondent", "form_responses", ["respondent_id"])
    op.create_index(
        "ix_form_responses_edit_token", "form_responses", ["edit_token_hash"],
        postgresql_where=sa.text("edit_token_hash IS NOT NULL"),
    )

    op.create_table(
        "form_option_counts",
        sa.Column("form_id", _UUID, sa.ForeignKey("forms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("question_id", sa.String(40), primary_key=True),
        sa.Column("option_id", sa.String(40), primary_key=True),
        sa.Column("taken", sa.Integer(), nullable=False, server_default="0"),
    )

    op.create_table(
        "form_uploads",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("form_id", _UUID, sa.ForeignKey("forms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("response_id", _UUID, sa.ForeignKey("form_responses.id", ondelete="SET NULL"), nullable=True),
        sa.Column("question_id", sa.String(40), nullable=False),
        sa.Column("file_id", _UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("draft_key_hash", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_form_uploads_form", "form_uploads", ["form_id"])
    op.create_index("ix_form_uploads_response", "form_uploads", ["response_id"])
    op.create_index(
        "ix_form_uploads_staged", "form_uploads", ["created_at"],
        postgresql_where=sa.text("response_id IS NULL"),
    )

    op.create_table(
        "form_notify",
        sa.Column("form_id", _UUID, sa.ForeignKey("forms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("mode", sa.String(8), nullable=False, server_default="each"),
        sa.Column("email_daily", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_push_count", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint("mode IN ('each','daily','off')", name="form_notify_mode_check"),
    )

    # Forms (WP-F1.1): "New answers to my forms" push switch.
    op.add_column(
        "push_preferences",
        sa.Column("form_response", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    # Forms: the admin switch for "Anyone with the link" (on by default).
    op.add_column(
        "app_settings",
        sa.Column("forms_link_answers", sa.Boolean(), nullable=False, server_default=sa.true()),
    )

    op.drop_constraint("file_share_links_resource_type_check", "file_share_links", type_="check")
    op.create_check_constraint(
        "file_share_links_resource_type_check",
        "file_share_links",
        "resource_type IN ('file','folder','album','form')",
    )

    op.execute(_CLOSE_FN)
    op.execute(
        """
        CREATE TRIGGER files_forms_close_on_trash
        AFTER UPDATE OF trashed_at ON files
        FOR EACH ROW
        WHEN (NEW.source_kind = 'form' AND NEW.trashed_at IS DISTINCT FROM OLD.trashed_at)
        EXECUTE FUNCTION forms_close_on_trash();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS files_forms_close_on_trash ON files")
    op.execute("DROP FUNCTION IF EXISTS forms_close_on_trash()")
    op.execute("DELETE FROM file_share_links WHERE resource_type = 'form'")
    op.drop_constraint("file_share_links_resource_type_check", "file_share_links", type_="check")
    op.create_check_constraint(
        "file_share_links_resource_type_check",
        "file_share_links",
        "resource_type IN ('file','folder','album')",
    )
    op.drop_column("app_settings", "forms_link_answers")
    op.drop_column("push_preferences", "form_response")
    op.drop_table("form_notify")
    op.drop_table("form_uploads")
    op.drop_table("form_option_counts")
    op.drop_table("form_responses")
    op.execute("DROP SEQUENCE IF EXISTS form_response_seq")
    op.drop_table("forms")
    # The shells go with their forms.
    op.execute("DELETE FROM files WHERE source_kind IN ('form', 'form_asset', 'form_upload')")

"""Notes phase 2 (N2.1): AI search over notes.

One vector per note, made from its title, text, list items and transcripts
(``notes.search_text``). There's no owner column on purpose: every read joins
``notes`` through ``notes/access.visible_predicate``, so the one access rule
stays the only rule. No vector index either: a search only ever looks at the
notes one person can open, which an exact scan handles at family scale.

``text_hash`` is the md5 of ``search_text`` when it was embedded, so ticking an
item doesn't re-embed the note but changing its words does.

The admin's switch is Mail's twin (``0249_mail_search``): unset follows the
default (on with a local indexer, off with a cloud one), and agreeing to a cloud
provider is agreeing to that one only.

Revision ID: 0263_notes_vectors
Revises: 0424_feedback_to_admin
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0263_notes_vectors"
down_revision = "0424_feedback_to_admin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "note_vectors",
        sa.Column("note_id", UUID(as_uuid=True), sa.ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("text_hash", sa.CHAR(32), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE note_vectors ADD COLUMN embedding_768 vector(768), ADD COLUMN embedding_1536 vector(1536)")
    op.add_column("app_settings", sa.Column("notes_ai_search", sa.Boolean, nullable=True))
    op.add_column("app_settings", sa.Column("notes_ai_search_provider", UUID(as_uuid=True), nullable=True))


def downgrade() -> None:
    op.drop_column("app_settings", "notes_ai_search_provider")
    op.drop_column("app_settings", "notes_ai_search")
    op.drop_table("note_vectors")

"""Forms (WP-F1.5): a form's answers written live into a linked Sheet.

* ``forms.sheet_columns`` — the linked tab's columns as Forms wrote them:
  ``[{key, title, col}]`` (``key`` is ``number``/``submitted``/``edited``/
  ``email``/``account`` or ``q:<question id>``). A column is found again by
  its header text, so columns the owner inserts or moves don't break it.
* ``forms.sheet_synced_at`` — when the sheet last caught up.
* ``spreadsheets.outside_content`` — the sheet holds other people's words
  (set while linked to a form, kept after unlinking): workspace retrieval
  marks a chat turn that read it as untrusted, like a web page.

Revision ID: 0291_forms_sheet
Revises: 0296_forms_notify
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0291_forms_sheet"
down_revision = "0296_forms_notify"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("forms", sa.Column("sheet_columns", JSONB(), nullable=True))
    op.add_column("forms", sa.Column("sheet_synced_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "spreadsheets",
        sa.Column("outside_content", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("spreadsheets", "outside_content")
    op.drop_column("forms", "sheet_synced_at")
    op.drop_column("forms", "sheet_columns")

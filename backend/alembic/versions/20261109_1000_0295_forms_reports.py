"""Forms (WP-F1.3): reports from people answering a link form.

``form_reports`` holds "Report this form" from the answer page: the form,
what the person said, and when. No IP and no account — reports come from
strangers too, and an admin only needs to know the form was reported and
why. Admin → Forms counts them; they go when the form is deleted for good.

Revision ID: 0295_forms_reports
Revises: 0290_forms_core
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0295_forms_reports"
down_revision = "0290_forms_core"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "form_reports",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("form_id", _UUID, sa.ForeignKey("forms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_form_reports_form", "form_reports", ["form_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_form_reports_form", table_name="form_reports")
    op.drop_table("form_reports")

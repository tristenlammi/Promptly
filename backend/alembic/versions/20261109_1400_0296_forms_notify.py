"""Forms (WP-F1.4): what the owner is told, and when.

* ``forms.close_pushed_at`` — when the owner was told "your form closed"
  (by its closing time or by its answer limit), so it's said once. Cleared
  when the form opens again.
* ``form_notify.emailed_at`` — when this person's daily email of new
  answers last went (one a day, at their Today summary time).

Revision ID: 0296_forms_notify
Revises: 0295_forms_reports
"""
import sqlalchemy as sa
from alembic import op

revision = "0296_forms_notify"
down_revision = "0295_forms_reports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("forms", sa.Column("close_pushed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("form_notify", sa.Column("emailed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("form_notify", "emailed_at")
    op.drop_column("forms", "close_pushed_at")

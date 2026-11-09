"""A one-time notice when an admin changes your account (admin privacy, AP5).

An admin can reset someone's password, set one from the edit form, change
their email or role, or turn off their two-step verification. Those used
to be silent (audit U1-U3). Now the person is emailed and notified, and
the next time they open Promptly, on any device, a banner says what
changed and when. These two columns hold that banner until they close it:

* ``users.admin_notice_at`` — when the latest admin change happened.
* ``users.admin_notice_kind`` — what it was (``password_reset``,
  ``email_changed``, ...). Several changes before they look: the latest
  wins, and Recent activity lists them all.

Revision ID: 0404_admin_action_notice
Revises: 0402_scrub_error_routes
"""
import sqlalchemy as sa
from alembic import op

revision = "0404_admin_action_notice"
down_revision = "0402_scrub_error_routes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("admin_notice_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("admin_notice_kind", sa.String(32), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "admin_notice_kind")
    op.drop_column("users", "admin_notice_at")

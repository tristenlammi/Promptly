"""Tasks & Reminders on by default: add it to everyone's apps once. New
accounts get it at sign-up (``items.service.install_defaults``); anyone
can still remove it afterwards.

Revision ID: 0239_tasks_default
Revises: 0238_snooze
"""
from alembic import op

revision = "0239_tasks_default"
down_revision = "0238_snooze"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "INSERT INTO item_installs (user_id, kind) SELECT id, 'tasks' FROM users "
        "ON CONFLICT DO NOTHING"
    )


def downgrade() -> None:
    # Can't tell who added it themselves, so leave everyone's apps alone.
    pass

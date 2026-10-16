"""Automation notify modes (R-152) and webhook request metadata (R-195).

``tasks.notify_mode``: never | failures | every | changes. Every run used to
push and write an inbox row. Existing automations get ``failures`` (or
``never`` when notifications were off).

``task_runs.trigger_meta``: an inbound webhook's headers (allow-listed) and
query string, so flows can branch on ``{{trigger.headers.*}}``.

``tasks.draft_graph``: an incomplete flow saved as a draft (R-149).

Revision ID: 0185_task_notify_mode
Revises: 0184_spreadsheet_versions
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0185_task_notify_mode"
down_revision = "0184_spreadsheet_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("notify_mode", sa.String(12), nullable=False, server_default="failures"),
    )
    op.execute("UPDATE tasks SET notify_mode = 'never' WHERE notify IS FALSE")
    op.add_column("task_runs", sa.Column("trigger_meta", postgresql.JSONB(), nullable=True))
    # A flow saved before it's complete (R-149): kept, never run.
    op.add_column("tasks", sa.Column("draft_graph", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("tasks", "draft_graph")
    op.drop_column("task_runs", "trigger_meta")
    op.drop_column("tasks", "notify_mode")

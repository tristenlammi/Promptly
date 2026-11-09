"""Porch's pushes and the admin's removals (WP-P1.7).

* ``push_preferences.porch`` — the app's switch in Account → Notifications
  (the per-kind modes live with Porch, in ``porch_profiles.push``).
* ``porch_profiles.birthday_pushed_on`` — the local day today's birthday
  pushes went, claimed once a day so a restart never sends them twice.
* ``porch_removals`` — a post or comment a server admin took down (from a
  report, or out of Everyone), with the reason the poster is shown.

Revision ID: 0272_porch_push
Revises: 0271_porch_talk
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0272_porch_push"
down_revision = "0271_porch_talk"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column("push_preferences", sa.Column("porch", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("porch_profiles", sa.Column("birthday_pushed_on", sa.Date(), nullable=True))
    op.create_table(
        "porch_removals",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("author_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_type", sa.String(8), nullable=False),
        sa.Column("target_id", UUID, nullable=False),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=True),
        sa.Column("scope", sa.String(8), nullable=False, server_default="all"),
        sa.Column("reason", sa.String(500), nullable=False, server_default=""),
        sa.Column("snippet", sa.String(200), nullable=False, server_default=""),
        sa.Column("removed_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("target_type IN ('post', 'comment')", name="ck_porch_removals_target"),
        sa.CheckConstraint("scope IN ('all', 'everyone')", name="ck_porch_removals_scope"),
    )
    op.create_index("ix_porch_removals_author", "porch_removals", ["author_id", "created_at"])
    op.add_column("porch_reports", sa.Column("note", sa.String(500), nullable=False, server_default=""))
    op.create_index("ix_porch_reports_target", "porch_reports", ["target_type", "target_id"])


def downgrade() -> None:
    op.drop_index("ix_porch_reports_target", table_name="porch_reports")
    op.drop_column("porch_reports", "note")
    op.drop_index("ix_porch_removals_author", table_name="porch_removals")
    op.drop_table("porch_removals")
    op.drop_column("porch_profiles", "birthday_pushed_on")
    op.drop_column("push_preferences", "porch")

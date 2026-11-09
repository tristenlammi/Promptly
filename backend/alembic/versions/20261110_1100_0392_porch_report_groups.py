"""Porch reports go to the admins of the group they were made in (WP-P2.0).

A server admin sees another person's Porch content only as a normal member
who can see it. So a report now records the group the reporter saw the
post through, and that group's owner and admins handle it; only reports
made in the built-in Everyone group (``group_id IS NULL``) go to the
server admins.

* ``porch_reports.group_id`` — the group it was reported in (NULL =
  Everyone), with an index for each group's queue. Open reports from before
  this are given one of the reporter's groups the post is in, unless the
  post is in Everyone (they stay NULL).
* ``ck_porch_reports_target`` also allows ``story`` (stories, WP-P2.1).
* ``porch_removals.group_id`` and ``scope = 'group'``: a group admin took a
  post out of their group only (it stays in its other groups).

Revision ID: 0392_porch_report_groups
Revises: 0272_porch_push
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0392_porch_report_groups"
down_revision = "0272_porch_push"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column(
        "porch_reports",
        sa.Column("group_id", UUID, sa.ForeignKey("porch_groups.id", ondelete="CASCADE"), nullable=True),
    )
    op.create_index("ix_porch_reports_group", "porch_reports", ["group_id", "status"])
    op.drop_constraint("ck_porch_reports_target", "porch_reports", type_="check")
    op.create_check_constraint("ck_porch_reports_target", "porch_reports", "target_type IN ('post', 'comment', 'story')")
    # Reports made before this: the post's group the reporter is in (any
    # one), unless it's in Everyone, where the server admins keep it.
    op.execute(
        """
        UPDATE porch_reports r SET group_id = (
            SELECT pg.group_id
            FROM porch_post_groups pg
            JOIN porch_groups g ON g.id = pg.group_id AND g.deleted_at IS NULL AND g.kind = 'custom'
            JOIN porch_group_members m ON m.group_id = g.id AND m.user_id = r.reporter_id AND m.status = 'member'
            WHERE pg.post_id = CASE WHEN r.target_type = 'comment'
                THEN (SELECT c.post_id FROM porch_comments c WHERE c.id = r.target_id) ELSE r.target_id END
            ORDER BY pg.group_id
            LIMIT 1
        )
        WHERE r.status = 'open' AND NOT EXISTS (
            SELECT 1 FROM porch_post_groups pg
            JOIN porch_groups g ON g.id = pg.group_id AND g.kind = 'everyone'
            WHERE pg.post_id = CASE WHEN r.target_type = 'comment'
                THEN (SELECT c.post_id FROM porch_comments c WHERE c.id = r.target_id) ELSE r.target_id END
        )
        """
    )

    op.add_column(
        "porch_removals",
        sa.Column("group_id", UUID, sa.ForeignKey("porch_groups.id", ondelete="SET NULL"), nullable=True),
    )
    op.drop_constraint("ck_porch_removals_scope", "porch_removals", type_="check")
    op.create_check_constraint("ck_porch_removals_scope", "porch_removals", "scope IN ('all', 'everyone', 'group')")


def downgrade() -> None:
    op.execute("DELETE FROM porch_removals WHERE scope = 'group'")
    op.drop_constraint("ck_porch_removals_scope", "porch_removals", type_="check")
    op.create_check_constraint("ck_porch_removals_scope", "porch_removals", "scope IN ('all', 'everyone')")
    op.drop_column("porch_removals", "group_id")
    op.execute("DELETE FROM porch_reports WHERE target_type = 'story'")
    op.drop_constraint("ck_porch_reports_target", "porch_reports", type_="check")
    op.create_check_constraint("ck_porch_reports_target", "porch_reports", "target_type IN ('post', 'comment')")
    op.drop_index("ix_porch_reports_group", table_name="porch_reports")
    op.drop_column("porch_reports", "group_id")

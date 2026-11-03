"""Links between things across apps: "Mentioned in" and "Linked".

* ``entity_links`` — one row per connection between two things, each named
  by a ``(kind, id)`` pair (a task is ``task`` / ``<tasks file id>:<task
  id>``, an event ``event`` / ``<event id>`` …, see ``app/links/refs.py``).
  ``link_type`` is ``mention`` (the source's text mentions the target; kept
  in step with the text whenever the source is saved or sent) or ``link``
  (someone linked the two by hand; two-way, stored once in a canonical
  order). Nothing about either side is stored here — titles are always
  read live, as the viewer can see them.

Revision ID: 0234_links
Revises: 0233_cal_more
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0234_links"
down_revision = "0233_cal_more"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "entity_links",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("source_kind", sa.String(16), nullable=False),
        sa.Column("source_id", sa.String(120), nullable=False),
        sa.Column("target_kind", sa.String(16), nullable=False),
        sa.Column("target_id", sa.String(120), nullable=False),
        sa.Column("link_type", sa.String(8), nullable=False),
        sa.Column("created_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("link_type IN ('mention', 'link')", name="ck_entity_links_type"),
        sa.UniqueConstraint("link_type", "source_kind", "source_id", "target_kind", "target_id", name="uq_entity_links"),
    )
    op.create_index("ix_entity_links_source", "entity_links", ["source_kind", "source_id"])
    op.create_index("ix_entity_links_target", "entity_links", ["target_kind", "target_id"])


def downgrade() -> None:
    op.drop_index("ix_entity_links_target", table_name="entity_links")
    op.drop_index("ix_entity_links_source", table_name="entity_links")
    op.drop_table("entity_links")

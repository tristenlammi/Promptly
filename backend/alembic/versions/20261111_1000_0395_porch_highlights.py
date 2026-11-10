"""Porch highlights (WP-P2.4): stories you keep on your profile, under a
name and a cover. Each story in one still shows only to the people in the
groups it went to (``access.visible_story(live=False)``), so Mum sees the
family stories in a highlight and your mates only theirs.

* ``porch_highlights`` — yours: a name (40), a cover story (SET NULL: the
  first one shown takes over), and its place in your row.
* ``porch_highlight_items`` — its stories, in order. Deleting a story takes
  it out (CASCADE; the API also drops a highlight left empty).

The plan numbered this 0391; Porch's wave-2 range is 0393–0399.

Revision ID: 0395_porch_highlights
Revises: 0394_porch_story_audience
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0395_porch_highlights"
down_revision = "0394_porch_story_audience"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "porch_highlights",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("owner_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("cover_story_id", UUID, sa.ForeignKey("porch_stories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_porch_highlights_owner", "porch_highlights", ["owner_id", "position"])
    op.create_table(
        "porch_highlight_items",
        sa.Column("highlight_id", UUID, sa.ForeignKey("porch_highlights.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("story_id", UUID, sa.ForeignKey("porch_stories.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("position", sa.SmallInteger(), nullable=False, server_default="0"),
    )
    op.create_index("ix_porch_highlight_items_story", "porch_highlight_items", ["story_id"])


def downgrade() -> None:
    op.drop_table("porch_highlight_items")
    op.drop_table("porch_highlights")

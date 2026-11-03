"""Recently opened things across apps ("pick up where you left off").

One small row per (person, kind, thing): the last time they opened it and
the title it had then. Upserted on open, capped per person in the app
(``app/today/recents.py``), and filtered for access on read.

Also two expression indexes on the GeoNames gazetteer so Places can match
a free-text town ("Kyoto") to a place by name without a scan.

Revision ID: 0237_recents
Revises: 0236_trash
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0237_recents"
down_revision = "0236_trash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recent_opens",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(300), nullable=False, server_default=""),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("user_id", "kind", "entity_id", name="pk_recent_opens"),
    )
    op.create_index("ix_recent_opens_user_opened", "recent_opens", ["user_id", sa.text("opened_at DESC")])
    op.execute("CREATE INDEX IF NOT EXISTS ix_geo_places_lower_name ON geo_places (lower(name))")
    op.execute("CREATE INDEX IF NOT EXISTS ix_geo_places_lower_ascii ON geo_places (lower(ascii_name))")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_geo_places_lower_ascii")
    op.execute("DROP INDEX IF EXISTS ix_geo_places_lower_name")
    op.drop_index("ix_recent_opens_user_opened", table_name="recent_opens")
    op.drop_table("recent_opens")

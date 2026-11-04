"""P Maps: saved places, recents, where you parked, the timeline, live sharing.

Revision ID: 0242_maps
Revises: 0241_model_locked
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0242_maps"
down_revision = "0241_model_locked"
branch_labels = None
depends_on = None


def _user(name: str = "user_id", **kw):
    return sa.Column(name, UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, **kw)


def upgrade() -> None:
    # The phone's driving screen signs in with an app password.
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload','maps']::varchar[]",
    )
    op.create_table(
        "map_places",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        _user(index=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("list_name", sa.String(80)),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("address", sa.String(400)),
        sa.Column("note", sa.Text()),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "uq_map_places_home_work", "map_places", ["user_id", "kind"], unique=True,
        postgresql_where=sa.text("kind IN ('home', 'work')"),
    )
    op.create_table(
        "map_recents",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        _user(index=True),
        sa.Column("key", sa.String(40), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("address", sa.String(400)),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "key", name="uq_map_recents_user_key"),
    )
    op.create_table(
        "map_parked",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("note", sa.String(400)),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("source", sa.String(16), nullable=False),
    )
    op.create_table(
        "map_track_points",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        _user(),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("accuracy", sa.Float()),
        sa.Column("speed", sa.Float()),
        sa.Column("source", sa.String(16), nullable=False),
        sa.UniqueConstraint("user_id", "at", name="uq_map_track_user_at"),
    )
    op.create_table(
        "map_shares",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        _user("owner_id", index=True),
        _user("viewer_id", index=True),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("owner_id", "viewer_id", name="uq_map_share_pair"),
    )
    op.create_table(
        "map_live_locations",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("heading", sa.Float()),
        sa.Column("speed", sa.Float()),
        sa.Column("destination", sa.String(200)),
        sa.Column("eta", sa.DateTime(timezone=True)),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    for table in ("map_live_locations", "map_shares", "map_track_points", "map_parked", "map_recents", "map_places"):
        op.drop_table(table)
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.execute("UPDATE app_passwords SET scopes = array_remove(scopes, 'maps')")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload']::varchar[]",
    )

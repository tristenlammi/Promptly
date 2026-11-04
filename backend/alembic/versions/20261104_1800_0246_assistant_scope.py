"""App passwords may be allowed to use the phone assistant (``assistant``).

It reads your calendar and files and can change them after a spoken yes, which
is far more than ``maps`` suggests. Phones linked so far could already do all of
this through the maps route, so they keep it.

Revision ID: 0246_assistant_scope
Revises: 0245_map_preferred
"""
from alembic import op

revision = "0246_assistant_scope"
down_revision = "0245_map_preferred"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload','maps','assistant']::varchar[]",
    )
    op.execute("UPDATE app_passwords SET scopes = array_append(scopes, 'assistant') WHERE 'maps' = ANY(scopes)")


def downgrade() -> None:
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.execute("UPDATE app_passwords SET scopes = array_remove(scopes, 'assistant')")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload','maps']::varchar[]",
    )

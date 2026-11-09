"""App passwords may feed the phone's home-screen widgets (``widgets``).

The widgets (Agenda, Tasks, Notes) read a small snapshot and tick tasks off
(``app/widgets``). That's narrower than what a linked phone can already
reach through ``assistant``, so every phone that has ``assistant`` gets
``widgets`` too and nobody has to link their phone again. It can be
unticked per phone in Account → Devices.

Revision ID: 0262_notes_widgets_scope
Revises: 0265_notes_keep_import
"""
from alembic import op

revision = "0262_notes_widgets_scope"
down_revision = "0265_notes_keep_import"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload','maps','assistant','widgets']::varchar[]",
    )
    op.execute(
        "UPDATE app_passwords SET scopes = array_append(scopes, 'widgets') "
        "WHERE 'assistant' = ANY(scopes) AND NOT ('widgets' = ANY(scopes))"
    )


def downgrade() -> None:
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.execute("UPDATE app_passwords SET scopes = array_remove(scopes, 'widgets')")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload','maps','assistant']::varchar[]",
    )

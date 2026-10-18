"""App passwords may be allowed to delete (``dav:delete``).

Without it a device's WebDAV DELETE leaves the file in Promptly, so a
phone clearing space never takes its backup with it. Existing passwords
don't get it: from now on they keep what their device deletes.

Revision ID: 0225_app_password_delete
Revises: 0224_photo_family
"""
from alembic import op

revision = "0225_app_password_delete"
down_revision = "0224_photo_family"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','dav:delete','upload']::varchar[]",
    )


def downgrade() -> None:
    op.execute("UPDATE app_passwords SET scopes = array_remove(scopes, 'dav:delete')")
    op.drop_constraint("ck_app_passwords_scopes", "app_passwords", type_="check")
    op.create_check_constraint(
        "ck_app_passwords_scopes",
        "app_passwords",
        "scopes <@ ARRAY['dav:read','dav:write','upload']::varchar[]",
    )

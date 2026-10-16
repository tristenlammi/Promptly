"""App passwords for devices (WP-8.3, Part C §5.7).

One per device (a phone's PhotoSync, a laptop's rclone): only its SHA-256
is kept, its scopes say what it may do (WebDAV read / write, resumable
upload), and each is revoked on its own.

Revision ID: 0205_app_passwords
Revises: 0204_upload_large_cap
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0205_app_passwords"
down_revision = "0204_upload_large_cap"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_passwords",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("hint", sa.String(16), nullable=False),
        sa.Column("scopes", postgresql.ARRAY(sa.String(16)), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_ip", sa.String(64), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("scopes <@ ARRAY['dav:read','dav:write','upload']::varchar[]", name="ck_app_passwords_scopes"),
    )
    op.create_index("ix_app_passwords_user_id", "app_passwords", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_app_passwords_user_id", table_name="app_passwords")
    op.drop_table("app_passwords")

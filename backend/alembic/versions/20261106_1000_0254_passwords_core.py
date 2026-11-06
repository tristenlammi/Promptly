"""Promptly Passwords: the vault's tables. All crypto material is opaque here.

Revision ID: 0254_passwords_core
Revises: 0253_mail_folder_labels
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0254_passwords_core"
down_revision = "0253_mail_folder_labels"
branch_labels = None
depends_on = None


def _uuid_pk():
    return sa.Column("id", UUID(as_uuid=True), primary_key=True)


def _created():
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def _user(name="user_id", nullable=False, ondelete="CASCADE", **kw):
    return sa.Column(name, UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete=ondelete), nullable=nullable, **kw)


def upgrade() -> None:
    op.create_table(
        "pw_accounts",
        _uuid_pk(),
        _user(unique=True),
        sa.Column("format_version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("kdf", JSONB, nullable=False),
        sa.Column("salt", sa.LargeBinary, nullable=False),
        sa.Column("auth_salt", sa.LargeBinary, nullable=False),
        sa.Column("auth_hash", sa.LargeBinary, nullable=False),
        sa.Column("wrapped_keyset", sa.LargeBinary, nullable=False),
        sa.Column("x25519_pub", sa.LargeBinary, nullable=False),
        sa.Column("ed25519_pub", sa.LargeBinary, nullable=False),
        sa.Column("failed_attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("locked_until", sa.DateTime(timezone=True)),
        sa.Column("kit_confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("kit_checked_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        _created(),
    )
    op.create_table(
        "pw_devices",
        _uuid_pk(),
        _user(index=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("scopes", JSONB, nullable=False),
        sa.Column("token_version", sa.Integer, nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        _created(),
    )
    op.create_table(
        "pw_sessions",
        _uuid_pk(),
        _user(index=True),
        sa.Column("device_id", UUID(as_uuid=True), sa.ForeignKey("pw_devices.id", ondelete="CASCADE")),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("token_version", sa.Integer, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("hard_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        _created(),
    )
    op.create_table(
        "pw_connects",
        _uuid_pk(),
        sa.Column("code", sa.String(16), nullable=False, unique=True),
        sa.Column("poll_hash", sa.String(64), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("scopes", JSONB, nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        _user(nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _created(),
    )
    op.create_table(
        "pw_device_requests",
        _uuid_pk(),
        _user(index=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("code", sa.String(16), nullable=False),
        sa.Column("poll_hash", sa.String(64), nullable=False),
        sa.Column("device_pub", sa.LargeBinary, nullable=False),
        sa.Column("approver_pub", sa.LargeBinary),
        sa.Column("payload", sa.LargeBinary),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _created(),
    )
    op.create_table(
        "pw_vaults",
        _uuid_pk(),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("generation", sa.Integer, nullable=False, server_default="1"),
        sa.Column("encrypted_name", sa.LargeBinary, nullable=False),
        _user("created_by", nullable=True, ondelete="SET NULL"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        _created(),
    )
    op.create_table(
        "pw_vault_members",
        sa.Column("vault_id", UUID(as_uuid=True), sa.ForeignKey("pw_vaults.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True),
        sa.Column("role", sa.String(10), nullable=False),
        sa.Column("wrapped_key", sa.LargeBinary, nullable=False),
        sa.Column("signature", sa.LargeBinary, nullable=False),
        _user("granted_by", nullable=True, ondelete="SET NULL"),
        sa.Column("generation", sa.Integer, nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True)),
        _created(),
    )
    op.create_table(
        "pw_items",
        _uuid_pk(),
        sa.Column("vault_id", UUID(as_uuid=True), sa.ForeignKey("pw_vaults.id", ondelete="CASCADE"), nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.Column("blob", sa.LargeBinary),
        sa.Column("size_bucket", sa.Integer, nullable=False, server_default="0"),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        _created(),
    )
    op.create_index("ix_pw_items_vault_revision", "pw_items", ["vault_id", "revision"])
    op.create_table(
        "pw_item_versions",
        sa.Column("item_id", UUID(as_uuid=True), sa.ForeignKey("pw_items.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("revision", sa.BigInteger, primary_key=True),
        sa.Column("blob", sa.LargeBinary, nullable=False),
        _created(),
    )
    op.create_table(
        "pw_attachments",
        _uuid_pk(),
        sa.Column("item_id", UUID(as_uuid=True), sa.ForeignKey("pw_items.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("vault_id", UUID(as_uuid=True), sa.ForeignKey("pw_vaults.id", ondelete="CASCADE"), nullable=False, index=True),
        _user("uploaded_by", nullable=True, ondelete="SET NULL"),
        sa.Column("chunk_count", sa.Integer, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("complete", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("received", JSONB, nullable=False, server_default="[]"),
        _created(),
    )
    op.create_table(
        "pw_sends",
        _uuid_pk(),
        _user(index=True),
        sa.Column("blob", sa.LargeBinary, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("views_left", sa.Integer),
        sa.Column("password_salt", sa.LargeBinary),
        sa.Column("password_verifier", sa.LargeBinary),
        sa.Column("disabled_at", sa.DateTime(timezone=True)),
        _created(),
    )
    op.create_table(
        "pw_emergency",
        _uuid_pk(),
        _user("grantor_id", index=True),
        _user("grantee_id", index=True),
        sa.Column("wrapped", sa.LargeBinary),
        sa.Column("wait_days", sa.Integer, nullable=False),
        sa.Column("state", sa.String(12), nullable=False, server_default="invited"),
        sa.Column("requested_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("grantor_id", "grantee_id", name="uq_pw_emergency_pair"),
        _created(),
    )
    op.create_table(
        "pw_activity",
        _uuid_pk(),
        _user(),
        sa.Column("event", sa.String(40), nullable=False),
        sa.Column("device_id", UUID(as_uuid=True), sa.ForeignKey("pw_devices.id", ondelete="SET NULL")),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_pw_activity_user_at", "pw_activity", ["user_id", "at"])
    op.create_table(
        "pw_health",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("counts", JSONB, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "pw_settings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("preview_badge", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("min_kdf_m", sa.Integer, nullable=False, server_default="65536"),
        sa.Column("min_kdf_t", sa.Integer, nullable=False, server_default="3"),
        sa.Column("max_attachment_mb", sa.Integer, nullable=False, server_default="500"),
        sa.Column("breach_check", sa.Boolean, nullable=False, server_default="true"),
    )
    # Device approvals and vault invites get their own switch in Notifications.
    op.add_column("push_preferences", sa.Column("passwords", sa.Boolean, nullable=False, server_default="true"))


def downgrade() -> None:
    op.drop_column("push_preferences", "passwords")
    for table in (
        "pw_settings",
        "pw_health",
        "pw_activity",
        "pw_emergency",
        "pw_sends",
        "pw_attachments",
        "pw_item_versions",
        "pw_items",
        "pw_vault_members",
        "pw_vaults",
        "pw_device_requests",
        "pw_connects",
        "pw_sessions",
        "pw_devices",
        "pw_accounts",
    ):
        op.drop_table(table)

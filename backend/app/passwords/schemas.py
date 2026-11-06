"""Request and response bodies. Bytes travel as base64url."""
from __future__ import annotations

import base64
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, PlainSerializer


def _decode(v):
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v)
    if not isinstance(v, str):
        raise ValueError("expected base64url")
    s = v + "=" * (-len(v) % 4)
    try:
        return base64.urlsafe_b64decode(s.encode("ascii"))
    except Exception as e:  # noqa: BLE001
        raise ValueError("expected base64url") from e


def _encode(v: bytes) -> str:
    return base64.urlsafe_b64encode(bytes(v)).decode("ascii").rstrip("=")


B64 = Annotated[bytes, BeforeValidator(_decode), PlainSerializer(_encode, return_type=str)]


class _Base(BaseModel):
    # A validation error must not echo a key back into a log or response.
    model_config = ConfigDict(hide_input_in_errors=True)


class Kdf(_Base):
    alg: str
    m: int
    t: int
    p: int


class VaultGrant(_Base):
    wrapped_key: B64 = Field(max_length=1024)
    signature: B64 = Field(max_length=256)


class AccountCreate(_Base):
    account_id: uuid.UUID
    kdf: Kdf
    salt: B64 = Field(min_length=16, max_length=64)
    auth_key: B64 = Field(min_length=32, max_length=64)
    wrapped_keyset: B64 = Field(max_length=4096)
    x25519_pub: B64 = Field(min_length=32, max_length=32)
    ed25519_pub: B64 = Field(min_length=32, max_length=32)
    personal_vault_id: uuid.UUID
    personal_vault_name: B64 = Field(max_length=4096)
    personal_vault_grant: VaultGrant
    device_name: str | None = Field(default=None, max_length=120)


class Prelogin(_Base):
    user_id: uuid.UUID
    exists: bool
    account_id: uuid.UUID | None = None
    kdf: Kdf | None = None
    salt: B64 | None = None
    min_kdf: Kdf
    preview: bool
    enabled: bool
    server_time: datetime


class SessionCreate(_Base):
    auth_key: B64 = Field(min_length=32, max_length=64)


class SessionOut(_Base):
    token: str
    expires_at: datetime
    account_id: uuid.UUID
    wrapped_keyset: B64
    kdf: Kdf
    salt: B64
    x25519_pub: B64
    ed25519_pub: B64
    kit_confirmed: bool
    kit_checked_at: datetime | None
    user_id: uuid.UUID


class Rekey(_Base):
    auth_key: B64 = Field(min_length=32, max_length=64)
    new_kdf: Kdf
    new_salt: B64 = Field(min_length=16, max_length=64)
    new_auth_key: B64 = Field(min_length=32, max_length=64)
    new_wrapped_keyset: B64 = Field(max_length=4096)


class ResetVault(_Base):
    confirm: str
    totp_code: str | None = Field(default=None, max_length=16)
    backup_code: str | None = Field(default=None, max_length=32)
    password: str | None = Field(default=None, max_length=512)


class KitState(_Base):
    confirmed: bool = True


class VaultCreate(_Base):
    id: uuid.UUID
    name: B64 = Field(max_length=4096)
    grant: VaultGrant


class VaultOut(_Base):
    id: uuid.UUID
    kind: str
    revision: int
    generation: int
    name: B64
    role: str
    wrapped_key: B64
    signature: B64
    granted_by: uuid.UUID | None
    member_generation: int
    accepted: bool
    member_count: int
    trash_count: int = 0


class VaultRename(_Base):
    name: B64 = Field(max_length=4096)


class ItemWrite(_Base):
    id: uuid.UUID
    base_revision: int = 0
    blob: B64 | None = Field(default=None, max_length=8 * 1024 * 1024)
    deleted: bool = False
    purge: bool = False


class ItemBatch(_Base):
    items: list[ItemWrite] = Field(max_length=500)


class ItemOut(_Base):
    id: uuid.UUID
    revision: int
    blob: B64 | None
    deleted: bool
    purged: bool
    updated_at: datetime


class ChangesOut(_Base):
    revision: int
    generation: int
    items: list[ItemOut]
    more: bool


class ConflictOut(_Base):
    id: uuid.UUID
    reason: str
    revision: int | None = None
    blob: B64 | None = None
    deleted: bool = False


class BatchOut(_Base):
    revision: int
    applied: list[uuid.UUID]
    conflicts: list[ConflictOut]


class VersionOut(_Base):
    revision: int
    blob: B64
    created_at: datetime


class MemberAdd(_Base):
    user_id: uuid.UUID
    role: str
    grant: VaultGrant


class MemberRole(_Base):
    role: str


class MemberOut(_Base):
    user_id: uuid.UUID
    username: str
    role: str
    granted_by: uuid.UUID | None
    generation: int
    accepted: bool
    x25519_pub: B64 | None
    ed25519_pub: B64 | None


class PublicKeys(_Base):
    user_id: uuid.UUID
    username: str
    x25519_pub: B64
    ed25519_pub: B64


class RotateMember(_Base):
    user_id: uuid.UUID
    grant: VaultGrant


class RotateItem(_Base):
    id: uuid.UUID
    blob: B64 = Field(max_length=8 * 1024 * 1024)
    versions: list["RotateVersion"] = Field(default_factory=list, max_length=40)


class RotateVersion(_Base):
    revision: int
    blob: B64 = Field(max_length=8 * 1024 * 1024)


class Rotate(_Base):
    from_generation: int
    name: B64 = Field(max_length=4096)
    remove_user_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    members: list[RotateMember] = Field(max_length=200)
    items: list[RotateItem]


class DeviceOut(_Base):
    id: uuid.UUID
    name: str
    platform: str
    scopes: list[str]
    last_seen_at: datetime | None
    created_at: datetime
    revoked_at: datetime | None
    current: bool = False


class ConnectStart(_Base):
    name: str = Field(min_length=1, max_length=120)
    platform: str = Field(min_length=1, max_length=16)
    scopes: list[str] = Field(default_factory=lambda: ["vault"], max_length=4)


class ConnectStarted(_Base):
    id: uuid.UUID
    code: str
    poll_secret: str
    expires_at: datetime


class ConnectInfo(_Base):
    name: str
    platform: str
    scopes: list[str]
    status: str


class ConnectPoll(_Base):
    id: uuid.UUID
    poll_secret: str = Field(max_length=120)


class ConnectResult(_Base):
    status: str
    token: str | None = None
    device_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None


class DeviceRegister(_Base):
    name: str = Field(min_length=1, max_length=120)
    platform: str = Field(min_length=1, max_length=16)
    scopes: list[str] = Field(default_factory=lambda: ["vault"], max_length=4)


class DeviceRequestCreate(_Base):
    name: str = Field(min_length=1, max_length=120)
    platform: str = Field(min_length=1, max_length=16)
    device_pub: B64 = Field(min_length=32, max_length=32)


class DeviceRequestCreated(_Base):
    id: uuid.UUID
    code: str
    poll_secret: str
    expires_at: datetime


class DeviceRequestOut(_Base):
    id: uuid.UUID
    name: str
    platform: str
    code: str
    device_pub: B64
    approver_pub: B64 | None
    status: str
    created_at: datetime
    expires_at: datetime


class DeviceRequestApprover(_Base):
    approver_pub: B64 = Field(min_length=32, max_length=32)


class DeviceRequestApprove(_Base):
    payload: B64 = Field(max_length=8192)


class DeviceRequestPoll(_Base):
    poll_secret: str = Field(max_length=120)


class DeviceRequestState(_Base):
    status: str
    approver_pub: B64 | None = None
    payload: B64 | None = None


class ActivityOut(_Base):
    event: str
    device_id: uuid.UUID | None
    at: datetime


class HealthIn(_Base):
    weak: int = Field(ge=0, le=1_000_000)
    reused: int = Field(ge=0, le=1_000_000)
    breached: int = Field(ge=0, le=1_000_000)
    old: int = Field(ge=0, le=1_000_000)


class PolicyOut(_Base):
    enabled: bool
    preview_badge: bool
    min_kdf_m: int
    min_kdf_t: int
    max_attachment_mb: int
    breach_check: bool


class PolicyPatch(_Base):
    enabled: bool | None = None
    preview_badge: bool | None = None
    min_kdf_m: int | None = Field(default=None, ge=65536, le=4194304)
    min_kdf_t: int | None = Field(default=None, ge=3, le=32)
    max_attachment_mb: int | None = Field(default=None, ge=1, le=100000)
    breach_check: bool | None = None


class AttachmentStart(_Base):
    id: uuid.UUID
    item_id: uuid.UUID
    chunk_count: int = Field(ge=1, le=200000)


class AttachmentOut(_Base):
    id: uuid.UUID
    item_id: uuid.UUID
    chunk_count: int
    size_bytes: int
    complete: bool
    received: list[int]


RotateItem.model_rebuild()

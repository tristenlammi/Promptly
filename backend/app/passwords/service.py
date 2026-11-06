"""Vault logic that isn't HTTP: proofs, sync writes, rotation, sweeping."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal
from app.passwords.models import (
    PwActivity,
    PwAttachment,
    PwConnect,
    PwDeviceRequest,
    PwItem,
    PwItemVersion,
    PwSend,
    PwSession,
    PwVault,
    PwVaultMember,
)

logger = logging.getLogger("promptly.passwords")

VERSIONS_KEPT = 20
TRASH_DAYS = 30
FAILED_LIMIT = 10
LOCK_MINUTES = 15
MAX_ITEM_BYTES = 2 * 1024 * 1024
MAX_ITEMS_PER_VAULT = 100_000
# Attachments, per person, across every vault they upload to.
QUOTA_MB = int(os.environ.get("PASSWORDS_QUOTA_MB", "20480"))
MAX_BATCH_ITEMS = 500
MAX_SEND_BYTES = 30 * 1024 * 1024
ATTACHMENT_CHUNK_BYTES = 1024 * 1024 + 64

ROLES = ("manage", "edit", "view", "fill")
WRITE_ROLES = ("manage", "edit")


def verifier(salt: bytes, auth_key: bytes) -> bytes:
    """``auth_key`` is a 256-bit HKDF output, so a slow hash adds nothing."""
    return hmac.new(salt, auth_key, hashlib.sha256).digest()


def verify(salt: bytes, stored: bytes, auth_key: bytes) -> bool:
    return hmac.compare_digest(verifier(salt, auth_key), stored)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def activity(db: AsyncSession, user_id: uuid.UUID, event: str, device_id: uuid.UUID | None = None) -> None:
    db.add(PwActivity(user_id=user_id, event=event, device_id=device_id))


async def member_of(db: AsyncSession, vault_id: uuid.UUID, user_id: uuid.UUID) -> PwVaultMember | None:
    return await db.get(PwVaultMember, (vault_id, user_id))


async def bump_revision(db: AsyncSession, vault_id: uuid.UUID) -> PwVault:
    """Locks the vault row, so writes to one vault are strictly ordered."""
    vault = await db.scalar(select(PwVault).where(PwVault.id == vault_id).with_for_update())
    if vault is None:
        raise LookupError("vault")
    vault.revision += 1
    return vault


async def write_batch(
    db: AsyncSession,
    vault_id: uuid.UUID,
    entries: list[dict],
) -> dict:
    """Apply a client's batch. An entry whose ``base_revision`` is behind the
    server's is a conflict and is left alone: nothing is ever silently lost,
    the client merges and tries again."""
    vault = await bump_revision(db, vault_id)
    rev = vault.revision
    applied: list[str] = []
    conflicts: list[dict] = []
    now = utcnow()
    for e in entries:
        item_id: uuid.UUID = e["id"]
        row = await db.get(PwItem, item_id, with_for_update=True)
        if row is not None and row.vault_id != vault_id:
            # Item ids are global: another vault's id can't be overwritten from here.
            conflicts.append({"id": str(item_id), "reason": "other_vault"})
            continue
        if row is None:
            if e.get("purge"):
                continue
            db.add(
                PwItem(
                    id=item_id,
                    vault_id=vault_id,
                    revision=rev,
                    blob=e["blob"],
                    size_bucket=len(e["blob"]),
                    deleted_at=now if e.get("deleted") else None,
                )
            )
            applied.append(str(item_id))
            continue
        if row.revision > int(e.get("base_revision", 0)):
            conflicts.append(
                {
                    "id": str(item_id),
                    "reason": "changed",
                    "revision": row.revision,
                    "blob": row.blob,
                    "deleted": row.deleted_at is not None,
                }
            )
            continue
        if e.get("purge"):
            await db.execute(delete(PwItemVersion).where(PwItemVersion.item_id == item_id))
            # Its attachments go with it: nobody can place them any more.
            for a in (await db.execute(select(PwAttachment).where(PwAttachment.item_id == item_id))).scalars().all():
                remove_attachment_files(vault_id, a.id)
                await db.delete(a)
            row.blob = None
            row.size_bucket = 0
            row.deleted_at = row.deleted_at or now
            row.revision = rev
            applied.append(str(item_id))
            continue
        blob = e.get("blob")
        if blob is not None and row.blob is not None and blob != row.blob:
            db.add(PwItemVersion(item_id=item_id, revision=row.revision, blob=row.blob))
            await _trim_versions(db, item_id)
        if blob is not None:
            row.blob = blob
            row.size_bucket = len(blob)
        row.deleted_at = (row.deleted_at or now) if e.get("deleted") else None
        row.revision = rev
        applied.append(str(item_id))
    if not applied:
        # Nothing landed, so the revision needn't move.
        vault.revision -= 1
    return {"revision": vault.revision, "applied": applied, "conflicts": conflicts}


async def _trim_versions(db: AsyncSession, item_id: uuid.UUID) -> None:
    keep = (
        select(PwItemVersion.revision)
        .where(PwItemVersion.item_id == item_id)
        .order_by(PwItemVersion.revision.desc())
        .limit(VERSIONS_KEPT - 1)
    )
    await db.execute(delete(PwItemVersion).where(PwItemVersion.item_id == item_id, PwItemVersion.revision.not_in(keep)))


def attachment_root() -> Path:
    from app.files import storage

    return Path(storage.UPLOAD_ROOT) / "passwords"


def attachment_dir(vault_id: uuid.UUID, attachment_id: uuid.UUID) -> Path:
    return attachment_root() / str(vault_id) / str(attachment_id)


def chunk_path(vault_id: uuid.UUID, attachment_id: uuid.UUID, index: int) -> Path:
    return attachment_dir(vault_id, attachment_id) / f"{index:08d}.bin"


def write_chunk(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def remove_attachment_files(vault_id: uuid.UUID, attachment_id: uuid.UUID | None = None) -> None:
    target = attachment_root() / str(vault_id)
    if attachment_id is not None:
        target = target / str(attachment_id)
    shutil.rmtree(target, ignore_errors=True)


async def sweep(db: AsyncSession) -> dict[str, int]:
    """Expired Sends, requests and sessions; Trash past its 30 days; files whose
    rows have gone (a deleted user cascades rows, not files)."""
    now = utcnow()
    out: dict[str, int] = {}
    for model, cond, name in (
        (PwConnect, PwConnect.expires_at < now, "connects"),
        (PwDeviceRequest, PwDeviceRequest.expires_at < now, "device_requests"),
        (PwSend, PwSend.expires_at < now, "sends"),
        (PwSession, PwSession.hard_expires_at < now, "sessions"),
    ):
        res = await db.execute(delete(model).where(cond))
        out[name] = res.rowcount or 0

    stale = (
        await db.execute(
            select(PwItem).where(PwItem.deleted_at.is_not(None), PwItem.blob.is_not(None), PwItem.deleted_at < now - timedelta(days=TRASH_DAYS))
        )
    ).scalars().all()
    for row in stale:
        vault = await bump_revision(db, row.vault_id)
        await db.execute(delete(PwItemVersion).where(PwItemVersion.item_id == row.id))
        atts = (await db.execute(select(PwAttachment).where(PwAttachment.item_id == row.id))).scalars().all()
        for a in atts:
            remove_attachment_files(row.vault_id, a.id)
            await db.delete(a)
        row.blob = None
        row.size_bucket = 0
        row.revision = vault.revision
    out["trash"] = len(stale)
    # Uploads nobody finished.
    abandoned = (await db.execute(select(PwAttachment).where(PwAttachment.complete.is_(False), PwAttachment.created_at < now - timedelta(days=2)))).scalars().all()
    for a in abandoned:
        remove_attachment_files(a.vault_id, a.id)
        await db.delete(a)
    out["abandoned_uploads"] = len(abandoned)
    # Vaults whose last member was a deleted user: nobody can ever open them.
    orphaned = await db.execute(delete(PwVault).where(~PwVault.id.in_(select(PwVaultMember.vault_id))))
    out["empty_vaults"] = orphaned.rowcount or 0
    await db.commit()

    # Attachment folders with no vault row left.
    root = attachment_root()
    removed = 0
    if root.is_dir():
        known = {str(v) for v in (await db.execute(select(PwVault.id))).scalars().all()}
        for child in root.iterdir():
            if child.is_dir() and child.name not in known:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
    out["orphans"] = removed
    return out


async def _loop() -> None:
    while True:
        await asyncio.sleep(3600)
        try:
            async with SessionLocal() as db:
                await sweep(db)
        except Exception:  # noqa: BLE001 — the loop must outlive one bad sweep
            logger.exception("Passwords sweep failed")


def start_password_loops() -> asyncio.Task:
    return asyncio.create_task(_loop(), name="passwords-sweep")


async def member_count(db: AsyncSession, vault_id: uuid.UUID) -> int:
    return int(await db.scalar(select(func.count()).select_from(PwVaultMember).where(PwVaultMember.vault_id == vault_id)) or 0)

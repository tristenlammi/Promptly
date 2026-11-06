"""Things the vault page asks the server to do for it, all carrying no vault content:
attachment chunks, the breach range lookup, the 2FA and passkey directories, and
favicons. What the server sees in each is noted beside it.
"""
from __future__ import annotations

import logging
import re
import time
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.passwords import schemas as s
from app.passwords import service
from app.passwords.deps import VaultSession, parse_uuid, policy, require_enabled, require_session
from app.passwords.models import PwAttachment, PwItem
from app.passwords.router import _member, _QuietRoute, _require

logger = logging.getLogger("promptly.passwords")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])


# ------------------------------------------------------------------ attachments


def _att_out(a: PwAttachment) -> s.AttachmentOut:
    return s.AttachmentOut(id=a.id, item_id=a.item_id, chunk_count=a.chunk_count, size_bytes=a.size_bytes, complete=a.complete, received=a.received)


@router.post("/vaults/{vault_id}/attachments", response_model=s.AttachmentOut)
async def attachment_start(vault_id: str, body: s.AttachmentStart, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> s.AttachmentOut:
    """Start or resume. The server sees a chunk count, which is the size to the MiB."""
    vault, member = await _member(db, vault_id, session.user)
    _require(member, service.WRITE_ROLES)
    limit = (await policy(db)).max_attachment_mb
    if body.chunk_count > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"Attachments on this server can be up to {limit} MB.")
    item = await db.get(PwItem, body.item_id)
    if item is None or item.vault_id != vault.id:
        # The item may not have synced yet; the client syncs first.
        raise HTTPException(status.HTTP_409_CONFLICT, "Save the item first.")
    row = await db.get(PwAttachment, body.id)
    if row is not None:
        if row.vault_id != vault.id or row.item_id != body.item_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        return _att_out(row)
    row = PwAttachment(id=body.id, item_id=body.item_id, vault_id=vault.id, uploaded_by=session.user.id, chunk_count=body.chunk_count, received=[])
    db.add(row)
    await db.commit()
    return _att_out(row)


async def _attachment(db: AsyncSession, vault_id: uuid.UUID, attachment_id: str) -> PwAttachment:
    row = await db.get(PwAttachment, parse_uuid(attachment_id))
    if row is None or row.vault_id != vault_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.put("/vaults/{vault_id}/attachments/{attachment_id}/chunks/{index}", status_code=status.HTTP_204_NO_CONTENT)
async def attachment_put(vault_id: str, attachment_id: str, index: int, request: Request, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, service.WRITE_ROLES)
    row = await _attachment(db, vault.id, attachment_id)
    if index < 0 or index >= row.chunk_count:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bad chunk number.")
    data = b""
    async for part in request.stream():
        data += part
        if len(data) > service.ATTACHMENT_CHUNK_BYTES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Chunk too large.")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty chunk.")
    service.write_chunk(service.chunk_path(vault.id, row.id, index), data)
    row = await db.scalar(select(PwAttachment).where(PwAttachment.id == row.id).with_for_update())
    if index not in row.received:
        row.received = [*row.received, index]
        row.size_bytes += len(data)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/vaults/{vault_id}/attachments/{attachment_id}/finish", response_model=s.AttachmentOut)
async def attachment_finish(vault_id: str, attachment_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> s.AttachmentOut:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, service.WRITE_ROLES)
    row = await _attachment(db, vault.id, attachment_id)
    if sorted(row.received) != list(range(row.chunk_count)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Some chunks are still missing.")
    row.complete = True
    await db.commit()
    return _att_out(row)


@router.get("/vaults/{vault_id}/attachments/{attachment_id}/chunks/{index}")
async def attachment_get(vault_id: str, attachment_id: str, index: int, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, _m = await _member(db, vault_id, session.user)
    row = await _attachment(db, vault.id, attachment_id)
    path = service.chunk_path(vault.id, row.id, index)
    if index < 0 or index >= row.chunk_count or not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return Response(content=path.read_bytes(), media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


@router.delete("/vaults/{vault_id}/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def attachment_delete(vault_id: str, attachment_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, service.WRITE_ROLES)
    row = await _attachment(db, vault.id, attachment_id)
    service.remove_attachment_files(vault.id, row.id)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ breach check


class _Range(s._Base):
    prefix: str = Field(min_length=5, max_length=5)


_HEX5 = re.compile(r"^[0-9A-F]{5}$")
HIBP_URL = "https://api.pwnedpasswords.com/range/"


@router.post("/breach/range")
async def breach_range(body: _Range, _session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """k-anonymity: five hash characters out, padded replies back, so HIBP sees this
    server's address and never the person's. In the body rather than the URL, so the
    prefix stays out of access logs here. Not stored."""
    if not (await policy(db)).breach_check:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Breach checks are off on this server.")
    prefix = body.prefix.upper()
    if not _HEX5.match(prefix):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bad prefix.")
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            r = await client.get(HIBP_URL + prefix, headers={"Add-Padding": "true", "User-Agent": "Promptly-Passwords"})
    except httpx.HTTPError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "The breach service can't be reached.") from None
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "The breach service can't be reached.")
    return Response(content=r.text, media_type="text/plain", headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ directories


_DIR_TTL = 24 * 3600
_directory: dict = {"at": 0.0, "data": None}
TWOFA_URL = "https://api.2fa.directory/v4/totp.json"
PASSKEYS_URL = "https://passkeys-api.2fa.directory/v1/supported.json"


@router.get("/directory")
async def directory(_session: VaultSession = Depends(require_session)) -> dict:
    """Which sites support 2FA and passkeys, cached here for a day. The whole list goes
    to every client, so nobody's domains ever reach the server for this. The data is
    2factorauth's: MIT and CC-BY-4.0, credited on the Security check page."""
    if _directory["data"] and time.time() - _directory["at"] < _DIR_TTL:
        return _directory["data"]
    out: dict = {"twofa": {}, "passkeys": {}}
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            t = await client.get(TWOFA_URL, headers={"User-Agent": "Promptly-Passwords"})
            if t.status_code == 200:
                out["twofa"] = {d: {"documentation": (v or {}).get("documentation")} for d, v in t.json().items()}
            p = await client.get(PASSKEYS_URL, headers={"User-Agent": "Promptly-Passwords"})
            if p.status_code == 200:
                out["passkeys"] = {d: True for d in p.json()}
    except (httpx.HTTPError, ValueError, AttributeError):
        logger.warning("Couldn't refresh the 2FA and passkey directories")
    if out["twofa"] or out["passkeys"]:
        _directory.update(at=time.time(), data=out)
    return _directory["data"] or out


# ------------------------------------------------------------------ favicons


class _Icon(s._Base):
    domain: str = Field(min_length=3, max_length=253)


_DOMAIN = re.compile(r"^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_ICON_TYPES = ("image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp")


@router.post("/icon")
async def icon(body: _Icon, _session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Off unless an item asks for it. The server sees the domain at that moment and
    keeps nothing; the site sees the server, not the person. In the body so it stays
    out of access logs. No SVG: it can carry script."""
    _ = db
    domain = body.domain.lower().strip()
    if not _DOMAIN.match(domain):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bad domain.")
    from app.net.safe_fetch import safe_fetch

    try:
        r = await safe_fetch("GET", f"https://{domain}/favicon.ico", timeout_seconds=6, max_bytes=256 * 1024, headers={"User-Agent": "Promptly-Passwords"})
    except Exception:  # noqa: BLE001 — a missing icon is never an error worth more than a 404
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No icon.") from None
    kind = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
    if r.status_code != 200 or kind not in _ICON_TYPES or not r.content:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No icon.")
    return Response(content=r.content, media_type=kind, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

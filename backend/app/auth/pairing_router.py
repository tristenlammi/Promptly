"""PromptlySync: pairing a phone by QR code, and its "do you have these?".

    POST /api/devices/pair            start: a one-time code (10 min) + its QR
    GET  /api/devices/pair/{code}     has the phone claimed it yet? (for the page)
    POST /api/devices/pair/claim      the phone, with the code: an app password
    POST /api/devices/have            the phone (app password): which of these
                                      files (SHA-256) are already in Photos, and
                                      which you deleted (don't send them back)

The QR is a link — ``<server>/sync?code=…`` — so the phone's camera opens
the download page for the app, and the app scans the same code to pair.
The code is the only secret in it: it works once, for ten minutes, and
pairing makes an ordinary app password for the device (Account → Devices
lists and revokes it), allowed to upload and read — never to delete.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()

PAIR_SECONDS = 600
SCOPES = ["upload", "dav:read"]
_KEY = "promptly:pair:{}"
_DONE = "promptly:pair-done:{}"  # what the waiting page reads once it's claimed


def _key(code: str) -> str:
    return _KEY.format(hashlib.sha256(code.encode()).hexdigest())


def _done(code: str) -> str:
    return _DONE.format(hashlib.sha256(code.encode()).hexdigest())


class PairStart(BaseModel):
    # Where the phone reaches this server (the page's own origin).
    origin: str = Field(min_length=8, max_length=300)


def _clean_origin(raw: str, request: Request) -> str:
    parts = urlsplit(raw.strip())
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path not in ("", "/"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That isn't this server's address.")
    origin = f"{parts.scheme}://{parts.netloc}"
    sent = (request.headers.get("origin") or "").rstrip("/")
    if sent and sent != origin:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That isn't this server's address.")
    return origin


@router.post("/pair")
async def pair_start(body: PairStart, request: Request, user: User = Depends(get_current_user)) -> dict[str, Any]:
    """A pairing code for a new phone, and the QR that carries it."""
    from app.mfa.totp import qr_data_uri
    from app.redis_client import redis

    origin = _clean_origin(body.origin, request)
    code = secrets.token_urlsafe(18)
    await redis.set(_key(code), json.dumps({"user_id": str(user.id), "device": None}), ex=PAIR_SECONDS)
    url = f"{origin}/sync?code={code}"
    return {
        "code": code,
        "url": url,
        "qr": qr_data_uri(url),
        "expires_at": int(time.time()) + PAIR_SECONDS,
        "apk_url": f"{origin}/downloads/PromptlySync.apk",
    }


@router.get("/pair/{code}")
async def pair_status(code: str, user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Waiting, paired (with the device's name), or expired."""
    from app.redis_client import redis

    for key, state in ((_done(code), "paired"), (_key(code), "waiting")):
        raw = await redis.get(key)
        if raw is None:
            continue
        data = json.loads(raw)
        if data.get("user_id") != str(user.id):
            break
        return {"state": "paired", "device": data["device"]} if state == "paired" else {"state": "waiting"}
    return {"state": "expired"}


class PairClaim(BaseModel):
    code: str = Field(min_length=8, max_length=64)
    device_name: str = Field(min_length=1, max_length=80)


@router.post("/pair/claim")
async def pair_claim(body: PairClaim, request: Request, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """The phone's half: the code from the QR → an app password for it."""
    from app import rate_limit
    from app.auth.app_passwords import MAX_PER_USER, AppPassword, hint, new_token, token_hash
    from app.auth.basic import client_ip
    from app.redis_client import redis
    from sqlalchemy import func, select

    ip = client_ip(request)
    if rate_limit._settings.RATE_LIMIT_ENABLED and not await rate_limit._limiter.test(rate_limit._LIMIT_LOGIN, "pair_claim", ip):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many tries. Wait a minute.")
    raw = await redis.getdel(_key(body.code))  # once only
    if raw is None:
        if rate_limit._settings.RATE_LIMIT_ENABLED:
            await rate_limit._limiter.hit(rate_limit._LIMIT_LOGIN, "pair_claim", ip)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That code has expired or was already used — make a new one in Files → Devices.")
    data = json.loads(raw)
    import uuid

    user = await db.get(User, uuid.UUID(data["user_id"]))
    if user is None or user.disabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That account isn't available.")
    live = await db.scalar(
        select(func.count(AppPassword.id)).where(AppPassword.user_id == user.id, AppPassword.revoked_at.is_(None))
    )
    if (live or 0) >= MAX_PER_USER:
        raise HTTPException(status.HTTP_409_CONFLICT, "That account has too many devices — revoke one first.")
    name = " ".join(body.device_name.split())[:80] or "Phone"
    token = new_token()
    row = AppPassword(user_id=user.id, name=name, token_hash=token_hash(token), hint=hint(token), scopes=list(SCOPES))
    db.add(row)
    from app.files.system_folders import ensure_camera_uploads

    await ensure_camera_uploads(db, user)
    await db.commit()
    await db.refresh(row)
    # Let the waiting page know — under its own key, so the code stays used.
    data["device"] = name
    await redis.set(_done(body.code), json.dumps(data), ex=PAIR_SECONDS)
    return {"username": user.username, "password": token, "device_id": str(row.id), "device_name": name}


class HaveBody(BaseModel):
    sha256: list[str] = Field(min_length=1, max_length=500)


@router.post("/have")
async def have(body: HaveBody, request: Request, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    """Of these files (by SHA-256): ``have`` — in this person's Photos now,
    so the phone needn't send them (and, being safely here, may free the
    space they take on the phone); ``skip`` — photos they deleted (in the
    trash, or deleted for good), never to be sent back. Only ``have`` is
    proof of a backup."""
    from sqlalchemy import select, text

    from app.auth.basic import client_ip, user_from_basic
    from app.files.models import UserFile
    from app.photos.library import photos_folders
    from app.photos.models import PhotoAsset

    user = await user_from_basic(db, request.headers.get("authorization"), scope="upload", ip=client_ip(request))
    wanted = {h.strip().lower() for h in body.sha256 if len(h.strip()) == 64}
    if not wanted:
        return {"have": [], "skip": []}
    tree = photos_folders(user.id)
    found = set(
        (
            await db.execute(
                select(UserFile.content_sha256).where(
                    UserFile.user_id == user.id,
                    UserFile.trashed_at.is_(None),
                    UserFile.content_sha256.in_(wanted),
                    UserFile.folder_id.in_(select(tree.c.id)),
                )
            )
        ).scalars().all()
    )
    trashed = set(
        (
            await db.execute(
                select(UserFile.content_sha256)
                .join(PhotoAsset, PhotoAsset.file_id == UserFile.id)
                .where(
                    UserFile.user_id == user.id,
                    UserFile.trashed_at.is_not(None),
                    UserFile.content_sha256.in_(wanted),
                )
            )
        ).scalars().all()
    )
    gone = set(
        (
            await db.execute(
                text("SELECT sha256 FROM photo_deleted_hashes WHERE user_id = :u AND sha256 = ANY(:h)"),
                {"u": user.id, "h": list(wanted)},
            )
        ).scalars().all()
    )
    return {"have": sorted(found), "skip": sorted((trashed | gone) - found)}


__all__ = ["router"]

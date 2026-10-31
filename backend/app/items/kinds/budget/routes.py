"""``/api/items/k/budget/…`` — the Up Bank connection.

  ``POST   /{file_id}/up/connect``  {token} → check with Up, keep it encrypted, first sync
  ``DELETE /{file_id}/up``          forget the token (and the webhook)
  ``POST   /{file_id}/up/sync``     sync now
  ``GET    /{file_id}/up/status``   connected? last sync, error, webhook, Up's categories
  ``POST   /hook/{file_id}``        Up's webhook (no login — the HMAC signature is the auth)

Status needs edit access to the file. Connecting, disconnecting and syncing
are for the file's **owner** only — the token is theirs, so a person the file
is shared with can't swap in their own bank, cut the owner's off, or make the
server call Up on the owner's behalf. No response ever carries the token.

Not covered (no hook for it): deleting the budget file doesn't revoke the
token or the webhook at Up — the server state goes with the file, and a
webhook for a missing file is answered 401 (Up disables it after failures).
The person can revoke the token in the Up app.
"""
from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import SessionLocal, get_db
from app.items import service
from app.items.kinds.budget import up

logger = logging.getLogger("promptly.items.budget.routes")

router = APIRouter()

MAX_HOOK_BODY = 64 * 1024


async def _edit(db: AsyncSession, user: User, file_id: uuid.UUID):  # noqa: ANN202
    try:
        row, doc, _ = await service.load(db, user, file_id, need="edit")
    except service.ItemNotFound:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    if doc.kind != "budget":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return row, doc


async def _owner(db: AsyncSession, row, user: User) -> User:  # noqa: ANN001
    """The file's owner — and only they may manage the bank connection."""
    if row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the budget's owner can manage the Up connection.")
    owner = await db.get(User, row.user_id)
    if owner is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return owner


class Connect(BaseModel):
    token: str = Field(min_length=8, max_length=500)


def _status_out(doc, token_saved: bool, cats: list | None, public: bool, sync: dict | None = None, is_owner: bool = True) -> dict:  # noqa: ANN001
    upd = (doc.data or {}).get("up") or {}
    sync = sync or {}
    return {
        "connected": bool(token_saved),
        "status": upd.get("status", "off"),
        "last_sync_at": sync.get("last_sync_at") or upd.get("last_sync_at"),
        "last_attempt_at": sync.get("last_attempt_at"),
        "last_error": upd.get("last_error", ""),
        "webhook": bool(upd.get("webhook")),
        "can_webhook": public,
        "added_last_sync": sync.get("added_last_sync", upd.get("added_last_sync", 0)),
        "full": upd.get("status") == "full",
        "is_owner": is_owner,
        "up_categories": cats or [],
    }


@router.post("/{file_id}/up/connect")
async def connect(
    file_id: uuid.UUID, payload: Connect, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    row, _doc = await _edit(db, user, file_id)
    owner = await _owner(db, row, user)
    try:
        token = up.clean_token(payload.token)
    except up.UpError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    cats: list[dict] = []
    hook: dict | None = None
    origin = await up.public_origin(db)
    try:
        async with up.UpClient(token) as client:
            await client.ping()
            try:
                cats = [
                    {"id": c["id"], "name": (c.get("attributes") or {}).get("name", c["id"]),
                     "parent": (((c.get("relationships") or {}).get("parent") or {}).get("data") or {}).get("id")}
                    for c in await client.categories() if isinstance(c, dict) and c.get("id")
                ][:120]
            except up.UpError:
                cats = []
            old = await service.get_state(db, file_id, up.WEBHOOK_KEY, secret=True)
            if origin and not old:
                try:
                    res = await client.create_webhook(f"{origin}/api/items/k/budget/hook/{file_id}")
                    secret = (res.get("attributes") or {}).get("secretKey")
                    if res.get("id") and secret:
                        hook = {"id": res["id"], "secret": secret}
                except up.UpError as e:
                    logger.info("Up webhook registration skipped: %s", e)
            elif old:
                hook = old
    except up.UpAuthError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Up didn't accept that token. Check you copied all of it.")
    except up.UpError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
    await service.set_state(db, file_id, up.TOKEN_KEY, token, secret=True)
    await service.set_state(db, file_id, up.CATEGORIES_KEY, cats or None)
    if hook:
        await service.set_state(db, file_id, up.WEBHOOK_KEY, hook, secret=True)
    await db.commit()

    def mark(d: dict) -> None:
        d.setdefault("up", {}).update({"connected": True, "status": "ok", "last_error": "", "webhook": bool(hook)})
        d.setdefault("settings", {})["onboarded"] = True

    await up._save(db, owner, file_id, mark)
    result = await up.sync_file(db, owner, file_id)
    _row, doc = await _edit(db, user, file_id)
    return {**_status_out(doc, True, cats, bool(origin), await up.sync_status(db, file_id)), "sync": result,
            "revision": doc.revision, "data": doc.data}


@router.delete("/{file_id}/up")
async def disconnect(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    row, _doc = await _edit(db, user, file_id)
    owner = await _owner(db, row, user)
    token = await service.get_state(db, file_id, up.TOKEN_KEY, secret=True)
    hook = await service.get_state(db, file_id, up.WEBHOOK_KEY, secret=True)
    if token and hook and hook.get("id"):
        try:
            async with up.UpClient(token) as client:
                await client.delete_webhook(hook["id"])
        except up.UpError as e:
            logger.info("Up webhook removal failed (forgetting it anyway): %s", e)
    for key in (up.TOKEN_KEY, up.WEBHOOK_KEY, up.CURSOR_KEY, up.CATEGORIES_KEY, up.CARRY_KEY):
        await service.set_state(db, file_id, key, None)
    await db.commit()

    def mark(d: dict) -> None:
        d["up"] = {"connected": False, "status": "off", "last_sync_at": (d.get("up") or {}).get("last_sync_at"),
                   "last_error": "", "webhook": False, "added_last_sync": 0}

    await up._save(db, owner, file_id, mark)
    _row, doc = await _edit(db, user, file_id)
    return {**_status_out(doc, False, None, False), "revision": doc.revision, "data": doc.data}


@router.post("/{file_id}/up/sync")
async def sync_now(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    row, _doc = await _edit(db, user, file_id)
    owner = await _owner(db, row, user)
    if not await service.get_state(db, file_id, up.TOKEN_KEY, secret=True):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Connect Up first.")
    result = await up.sync_file(db, owner, file_id)
    _row, doc = await _edit(db, user, file_id)
    cats = await service.get_state(db, file_id, up.CATEGORIES_KEY)
    return {**_status_out(doc, bool(await service.get_state(db, file_id, up.TOKEN_KEY, secret=True)), cats,
                          bool(await up.public_origin(db)), await up.sync_status(db, file_id)),
            "sync": result, "revision": doc.revision, "data": doc.data}


@router.get("/{file_id}/up/status")
async def get_status(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    row, doc = await _edit(db, user, file_id)
    token_saved = bool(await service.get_state(db, file_id, up.TOKEN_KEY, secret=True))
    cats = await service.get_state(db, file_id, up.CATEGORIES_KEY)
    return _status_out(doc, token_saved, cats, bool(await up.public_origin(db)), await up.sync_status(db, file_id),
                       is_owner=row.user_id == user.id)


# ----------------------------------------------------------------- webhook


async def _hook_sync(file_id: uuid.UUID, event: tuple[str, str]) -> None:
    from app.files.models import UserFile

    try:
        async with SessionLocal() as db:
            row = await db.get(UserFile, file_id)
            if row is None or row.trashed_at is not None:
                return
            owner = await db.get(User, row.user_id)
            if owner is None:
                return
            await up.sync_file(db, owner, file_id, event=event)
    except Exception:  # noqa: BLE001 — Up retries; the periodic sync catches up anyway
        logger.exception("Up webhook sync for %s failed", file_id)


@router.post("/hook/{file_id}")
async def webhook(file_id: uuid.UUID, request: Request, background: BackgroundTasks) -> dict:
    # Capped before reading: the declared length first, then while streaming.
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > MAX_HOOK_BODY:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Too large")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_HOOK_BODY:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Too large")
        chunks.append(chunk)
    body = b"".join(chunks)
    sig = request.headers.get("X-Up-Authenticity-Signature", "")
    async with SessionLocal() as db:
        hook = await service.get_state(db, file_id, up.WEBHOOK_KEY, secret=True)
    if not hook or not up.verify_signature(hook.get("secret", ""), body, sig):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad signature")
    try:
        payload = json.loads(body)
        d = payload.get("data") or {}
        kind = (d.get("attributes") or {}).get("eventType") or ""
        tid = ((((d.get("relationships") or {}).get("transaction") or {}).get("data")) or {}).get("id") or ""
    except (ValueError, AttributeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad payload")
    if kind in ("TRANSACTION_CREATED", "TRANSACTION_SETTLED", "TRANSACTION_DELETED") and tid:
        background.add_task(_hook_sync, file_id, (kind, str(tid)[:80]))
    return {"ok": True}

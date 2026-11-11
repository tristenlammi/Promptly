"""Passwords' live channel: ``/api/passwords/live``, a WebSocket that tells a
device "this vault has moved on to revision N, pull it" (BOOKMARKS.md, "When").

It carries vault ids and revision numbers only, never an item, a blob or a
count of anything: the device fetches what changed through the normal, checked
``/changes`` endpoint. The server can't read the vault anyway.

* **Signing in.** A browser can't put headers on a WebSocket, and a token in a
  URL ends up in logs. So the first message is ``{"token", "session"}``: the
  same bearer (a device token, or the web's access token) and vault session the
  HTTP API takes. Then ``{"t": "hello", "vaults": {id: revision}}`` says where
  each of the person's vaults is, so a device that was away can tell at once
  whether it missed anything.
* **After that.** ``{"t": "changed", "vault", "revision"}`` whenever a write to a
  vault they're a member of is committed (:func:`vault_changed`), and
  ``{"t": "ping"}`` every 25 s. A message both ways is what keeps a Chromium
  extension's service worker awake (Chrome 116+), and tells either end the
  other is still there.
* **Ending.** The session is checked again every 5 minutes without moving its
  idle expiry on, so an open socket never keeps a session alive by itself;
  locked, revoked or expired closes it with 4401.

One Redis channel per person (``pw:u:<id>``), as Rooms and Porch do. No DB
connection is held while the socket's open: each check uses a short session.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Iterable

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal
from app.passwords.deps import SCOPE_VAULT, VaultSession, identity_for, policy, session_for
from app.passwords.models import PwVault, PwVaultMember

logger = logging.getLogger(__name__)

router = APIRouter()

PING_SECONDS = 25.0
RECHECK_SECONDS = 300.0
SIGN_IN_SECONDS = 10.0

CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403


def channel(user_id: uuid.UUID | str) -> str:
    return f"pw:u:{user_id}"


async def vault_changed(db: AsyncSession, vault_id: uuid.UUID, revision: int) -> None:
    """Tell every member's devices that ``vault_id`` is at ``revision``. Call after
    the commit. Best effort: a dead Redis never fails a write, and devices still
    pull on their own once a minute."""
    try:
        members = (await db.execute(select(PwVaultMember.user_id).where(PwVaultMember.vault_id == vault_id))).scalars().all()
        await publish(members, {"t": "changed", "vault": str(vault_id), "revision": int(revision)})
    except Exception:  # noqa: BLE001
        logger.debug("passwords live publish failed", exc_info=True)


async def publish(user_ids: Iterable[uuid.UUID | str], event: dict) -> None:
    from app.redis_client import redis

    data = json.dumps(event)
    for uid in {str(u) for u in user_ids}:
        try:
            await redis.publish(channel(uid), data)
        except Exception:  # noqa: BLE001
            logger.debug("passwords live publish failed", exc_info=True)


async def _revisions(db: AsyncSession, user_id: uuid.UUID) -> dict[str, int]:
    rows = (
        await db.execute(select(PwVault.id, PwVault.revision).join(PwVaultMember, PwVaultMember.vault_id == PwVault.id).where(PwVaultMember.user_id == user_id))
    ).all()
    return {str(vid): int(rev) for vid, rev in rows}


async def _check(token: str, session_token: str, *, touch: bool) -> VaultSession:
    """Raises HTTPException as the HTTP API would."""
    async with SessionLocal() as db:
        if not (await policy(db)).enabled:
            raise HTTPException(403, "Passwords is turned off on this server.")
        identity = await identity_for(HTTPAuthorizationCredentials(scheme="Bearer", credentials=token), db)
        if identity.device is not None and SCOPE_VAULT not in (identity.device.scopes or []):
            raise HTTPException(403, "This device can't reach the vault.")
        return await session_for(identity, session_token, db, touch=touch)


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # noqa: BLE001
        pass


@router.websocket("/live")
async def live(ws: WebSocket) -> None:
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=SIGN_IN_SECONDS)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError, KeyError, RuntimeError):
        await _close(ws, CLOSE_UNAUTHORIZED)
        return
    token = first.get("token") if isinstance(first, dict) else None
    session_token = first.get("session") if isinstance(first, dict) else None
    if not isinstance(token, str) or not isinstance(session_token, str) or len(token) > 4096 or len(session_token) > 256:
        await _close(ws, CLOSE_UNAUTHORIZED)
        return
    try:
        vs = await _check(token, session_token, touch=True)
        async with SessionLocal() as db:
            vaults = await _revisions(db, vs.user.id)
    except HTTPException as e:
        await _close(ws, CLOSE_FORBIDDEN if e.status_code == 403 else CLOSE_UNAUTHORIZED)
        return
    user_id = vs.user.id

    from app.redis_client import redis

    pubsub = redis.pubsub()
    ch = channel(user_id)
    # Anything the client sends after signing in is ignored; reading is how a
    # disconnect is noticed.
    reader = asyncio.create_task(_drain(ws))
    try:
        # Subscribed before the hello, so nothing committed after it can be missed.
        await pubsub.subscribe(ch)
        await ws.send_json({"t": "hello", "vaults": vaults})
        checked = time.monotonic()
        while not reader.done():
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=PING_SECONDS)
            if reader.done():
                break
            if time.monotonic() - checked > RECHECK_SECONDS:
                checked = time.monotonic()
                try:
                    await _check(token, session_token, touch=False)
                except HTTPException as e:
                    await _close(ws, CLOSE_FORBIDDEN if e.status_code == 403 else CLOSE_UNAUTHORIZED)
                    return
            if message is None:
                await ws.send_json({"t": "ping"})
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            if isinstance(data, str) and data:
                await ws.send_text(data)
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        return
    except Exception:  # noqa: BLE001
        logger.debug("passwords live socket ended", exc_info=True)
        await _close(ws, 1011)
    finally:
        reader.cancel()
        try:
            await pubsub.unsubscribe(ch)
            closer = getattr(pubsub, "aclose", None) or pubsub.close
            await closer()
        except Exception:  # noqa: BLE001
            pass


async def _drain(ws: WebSocket) -> None:
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                return
    except Exception:  # noqa: BLE001
        return


__all__ = ["channel", "publish", "router", "vault_changed"]

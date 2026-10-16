"""The backend ↔ collab-server channel (WP-3.2, Part C §3.3).

Collab's snapshot call used ``SECRET_KEY`` itself as its bearer, on a route
nginx's ``/api/`` catch-all exposed. Now:

* collab calls ``/api/internal/...`` — nginx answers 404 for that prefix
  from outside, so only the docker network reaches it;
* both sides authenticate with a dedicated token: ``COLLAB_INTERNAL_TOKEN``
  when set, otherwise an HMAC of ``SECRET_KEY`` (the same derivation as
  ``collab/src/server.js``), so the token alone doesn't reveal the key;
* the backend can ask collab to cut a user's sockets the moment their
  access is revoked (``drop_user``), instead of at the next token refresh.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import uuid

from fastapi import HTTPException, status

from app.config import get_settings

logger = logging.getLogger("promptly.collab_internal")

COLLAB_INTERNAL_URL = os.environ.get("COLLAB_INTERNAL_URL", "http://collab:1234")


def internal_token() -> str:
    explicit = os.environ.get("COLLAB_INTERNAL_TOKEN", "").strip()
    if explicit:
        return explicit
    key = get_settings().SECRET_KEY.encode("utf-8")
    return hmac.new(key, b"promptly:collab-internal", hashlib.sha256).hexdigest()


def verify_internal_caller(authorization: str | None) -> None:
    """401/403 unless ``authorization`` carries the internal token."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This endpoint requires the internal bearer token",
        )
    presented = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(presented.encode("utf-8"), internal_token().encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal bearer token"
        )


async def drop_user(user_id: uuid.UUID, *, room: str | None = None) -> int:
    """Cut ``user_id``'s open collab sockets (all of them, or one room's).
    They reconnect and get a token only if they still have access.
    Best-effort: returns how many were dropped, 0 if collab is unreachable."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.post(
                f"{COLLAB_INTERNAL_URL}/internal/drop",
                json={"user_id": str(user_id), "room": room},
                headers={"Authorization": f"Bearer {internal_token()}"},
            )
        if r.status_code == 200:
            return int(r.json().get("dropped", 0))
        logger.warning("collab drop for %s returned %s", user_id, r.status_code)
    except Exception:  # noqa: BLE001 — the 5-minute re-auth sweep is the backstop
        logger.info("collab drop for %s didn't reach collab", user_id, exc_info=True)
    return 0


async def reset_room(room: str) -> bytes | None:
    """Freeze ``room`` for a restore (WP-6.2): collab stops storing it,
    refuses new connections, tells everyone to reload, closes their sockets,
    unloads it and hands back its live state (for the "before restoring"
    snapshot; ``None`` when it wasn't open). Raises when collab can't be
    reached — a restore must not write under a live room."""
    import base64

    import httpx

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            f"{COLLAB_INTERNAL_URL}/internal/reset",
            json={"room": room},
            headers={"Authorization": f"Bearer {internal_token()}"},
        )
    if r.status_code != 200:
        raise RuntimeError(f"collab reset returned {r.status_code}")
    state = r.json().get("state")
    return base64.b64decode(state) if state else None


async def live_state(room: str) -> bytes | None:
    """The room's in-memory state if it's open — newer than what's stored
    while the debounced store hasn't run. Best-effort: ``None`` when the room
    isn't open or collab can't be reached."""
    import base64

    import httpx

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.post(
                f"{COLLAB_INTERNAL_URL}/internal/state",
                json={"room": room},
                headers={"Authorization": f"Bearer {internal_token()}"},
            )
        if r.status_code == 200 and r.json().get("state"):
            return base64.b64decode(r.json()["state"])
    except Exception:  # noqa: BLE001 — fall back to the stored state
        logger.info("collab state for %s didn't come back", room, exc_info=True)
    return None


async def release_room(room: str) -> None:
    """Let ``room`` be opened again after a restore (it also expires on its
    own after 30 seconds)."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(
                f"{COLLAB_INTERNAL_URL}/internal/release",
                json={"room": room},
                headers={"Authorization": f"Bearer {internal_token()}"},
            )
    except Exception:  # noqa: BLE001 — the freeze expires by itself
        logger.info("collab release for %s didn't reach collab", room, exc_info=True)


def drop_user_soon(user_id: uuid.UUID, *, room: str | None = None) -> None:
    """Fire-and-forget :func:`drop_user` (after the revoking commit)."""
    from app.background import spawn

    spawn(drop_user(user_id, room=room), name="collab-drop")

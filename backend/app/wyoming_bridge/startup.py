"""Start/stop the Wyoming listener alongside the app.

Kept out of ``main.py`` so the refusal rules live next to the thing they
guard: this listener is unauthenticated by protocol, so every reason it
might decline to start belongs in one readable place.
"""
from __future__ import annotations

import asyncio
import logging
import uuid

from app.config import get_settings

logger = logging.getLogger("promptly.wyoming")

_server: asyncio.AbstractServer | None = None


async def start_wyoming() -> None:
    """Bind the Wyoming port, or explain in the log why we didn't.

    Every refusal is logged at WARNING rather than passing silently. An
    admin who set ``WYOMING_ENABLED=true`` and got nothing needs to know
    which of the preconditions they missed — a quiet no-op here would be
    debugged by packet capture.
    """
    global _server
    settings = get_settings()

    if not settings.WYOMING_ENABLED:
        return

    raw_user = (settings.WYOMING_USER_ID or "").strip()
    if not raw_user:
        logger.warning(
            "WYOMING_ENABLED is set but WYOMING_USER_ID is empty — the "
            "bridge needs to know whose commands satellites may run. Not "
            "starting."
        )
        return
    try:
        user_id = uuid.UUID(raw_user)
    except ValueError:
        logger.warning(
            "WYOMING_USER_ID (%r) isn't a valid user id. Not starting.",
            raw_user,
        )
        return

    # Import here: the ``wyoming`` package is only needed when the bridge
    # is switched on, so a missing dependency can't break boot for the
    # overwhelming majority who never enable it.
    try:
        from app.wyoming_bridge.server import serve
    except ImportError as exc:
        logger.warning(
            "Wyoming bridge enabled but the 'wyoming' package isn't "
            "installed (%s). Not starting.",
            exc,
        )
        return

    try:
        _server = await serve(
            settings.WYOMING_HOST, settings.WYOMING_PORT, user_id
        )
    except OSError as exc:
        # A busy port shouldn't take the whole app down with it.
        logger.warning(
            "Couldn't bind the Wyoming port %s:%s (%s). Not starting.",
            settings.WYOMING_HOST,
            settings.WYOMING_PORT,
            exc,
        )
        return

    logger.warning(
        "Wyoming bridge is LISTENING on %s:%s for user %s. This protocol "
        "has no authentication — keep the port on a trusted network.",
        settings.WYOMING_HOST,
        settings.WYOMING_PORT,
        user_id,
    )


async def stop_wyoming() -> None:
    global _server
    if _server is None:
        return
    _server.close()
    try:
        await _server.wait_closed()
    except Exception:  # noqa: BLE001 — never block shutdown
        pass
    _server = None

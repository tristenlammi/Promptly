"""Signing in on ``/api/talk/ws`` (WP-T2).

A browser can't put an ``Authorization`` header on a WebSocket, and the web
app's access token lives in memory (the refresh cookie is path-limited to
``/api/auth``). So the web asks ``POST /api/talk/ticket`` (signed in as usual)
for a **Talk ticket**: one use, 60 seconds, held in this process (single
worker, like the sessions it opens). The same call sets it as an HttpOnly,
SameSite=Strict cookie scoped to ``/api/talk/ws``, so the browser's socket
carries it without the ticket ever touching JavaScript or a URL; a client
that can't use the cookie may send ``?ticket=`` instead, which is harmless in
a log because it's spent on first use.

The phone signs in with its app password (``Authorization: Basic``, scope
``assistant``, as ``/api/assistant`` does), and native clients may send their
bearer token.
"""
from __future__ import annotations

import secrets
import time
import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.auth.models import User

COOKIE = "promptly_talk"
COOKIE_PATH = "/api/talk/ws"
TICKET_TTL_S = 60


@dataclass
class _Ticket:
    user_id: uuid.UUID
    token_version: int
    expires: float


_TICKETS: dict[str, _Ticket] = {}


def issue_ticket(user: User) -> str:
    now = time.monotonic()
    for key in [k for k, t in _TICKETS.items() if t.expires <= now]:
        _TICKETS.pop(key, None)
    ticket = secrets.token_urlsafe(32)
    _TICKETS[ticket] = _Ticket(user.id, int(user.token_version or 0), now + TICKET_TTL_S)
    return ticket


def _spend(ticket: str | None) -> _Ticket | None:
    if not ticket:
        return None
    found = _TICKETS.pop(ticket, None)
    if found is None or found.expires <= time.monotonic():
        return None
    return found


class NotSignedIn(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def socket_user(ws, db) -> tuple[User, str]:  # noqa: ANN001
    """The user on the other end, and how they signed in (``app_password``,
    ``bearer`` or ``ticket``). Raises :class:`NotSignedIn`."""
    from app.auth.basic import user_from_basic
    from app.auth.deps import SINGLE_USER_USERNAME, _resolve_custom_user, settings
    from app.rate_limit import _client_ip

    if settings.SINGLE_USER_MODE:
        from sqlalchemy import select

        user = await db.scalar(select(User).where(User.username == SINGLE_USER_USERNAME))
        if user is None:
            raise NotSignedIn(4401, "Not signed in.")
        return user, "single_user"

    header = ws.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        try:
            user = await user_from_basic(db, header, scope="assistant", ip=_client_ip(ws))
        except HTTPException as e:
            raise NotSignedIn(4403 if e.status_code == 403 else 4401, str(e.detail)) from None
        return user, "app_password"
    if header.lower().startswith("bearer "):
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=header.split(" ", 1)[1].strip())
        try:
            user = await _resolve_custom_user(creds, db)
        except HTTPException as e:
            raise NotSignedIn(4401, str(e.detail)) from None
        if user.must_change_password:
            raise NotSignedIn(4403, "Choose a new password first.")
        return user, "bearer"

    ticket = _spend(ws.cookies.get(COOKIE)) or _spend(ws.query_params.get("ticket"))
    if ticket is None:
        raise NotSignedIn(4401, "Not signed in.")
    user = await db.get(User, ticket.user_id)
    if user is None or user.disabled or int(user.token_version or 0) != ticket.token_version:
        raise NotSignedIn(4401, "Not signed in.")
    return user, "ticket"

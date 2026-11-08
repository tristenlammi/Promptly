"""Talk's endpoints (WP-T2): the conversation socket, its config and tickets.

``WS /api/talk/ws`` (protocol in ``protocol.py``), ``GET /api/talk/config``,
``POST /api/talk/ticket``. Each holds a DB session only while signing in and
setting up: a conversation can last many minutes, and every turn opens its
own short one (``reply.py``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from starlette.datastructures import Headers

from app.auth.models import User
from app.database import SessionLocal
from app.maps.router import assistant_user

from . import access, links, reply as chat, session as talk
from .auth import COOKIE, COOKIE_PATH, TICKET_TTL_S, NotSignedIn, issue_ticket, socket_user
from .protocol import (
    CLOSE_BAD_HELLO,
    CLOSE_BUSY,
    CLOSE_FORBIDDEN,
    CLOSE_NOT_FOUND,
    CLOSE_UNAUTHORIZED,
    CLOSE_UNAVAILABLE,
    PROTOCOL_VERSION,
    Hello,
    WebSocketTransport,
)

logger = logging.getLogger("promptly.talk")
router = APIRouter()

HELLO_TIMEOUT_S = 10.0
# One microphone message: at most 2 s of PCM16 (Opus packets are far smaller).
MAX_FRAME_BYTES = 64 * 1024 + 4


class _Connection:
    """What audit rows read from a request (client address, headers), kept
    from the socket that opened the conversation: a reply can outlive it."""

    def __init__(self, ws: WebSocket) -> None:
        self.client = ws.client
        self.headers = Headers(raw=list(ws.headers.raw))
        self.url = ws.url
        self.cookies: dict[str, str] = {}

    async def is_disconnected(self) -> bool:
        return False


@router.post("/ticket")
async def ticket(response: Response, request: Request, user: User = Depends(assistant_user)) -> dict[str, Any]:
    """A one-use pass for the Talk socket (see ``auth.py``)."""
    from app.auth.cookies import cookie_secure

    value = issue_ticket(user)
    response.set_cookie(
        key=COOKIE,
        value=value,
        max_age=TICKET_TTL_S,
        httponly=True,
        secure=cookie_secure(),
        samesite="strict",
        path=COOKIE_PATH,
    )
    response.headers["Cache-Control"] = "no-store"
    return {"ticket": value, "expires_in": TICKET_TTL_S}


@router.get("/config")
async def config(user: User = Depends(assistant_user)) -> dict[str, Any]:
    """Whether you can talk, your voice settings and the server's limits."""
    async with SessionLocal() as db:
        server = await access.server_talk(db)
        refused = await access.refusal(db, user, server)
    prefs = access.voice_prefs(user)
    return {
        "protocol": PROTOCOL_VERSION,
        "enabled": refused is None,
        "reason": refused,
        "voice_model_set": server.voice_model_set,
        "prefs": {
            "voice": prefs.voice,
            "speed": prefs.speed,
            "save": prefs.save,
            "turn_mode": prefs.turn_mode,
            "interrupt": prefs.interrupt,
            "captions": prefs.captions,
        },
        "limits": {
            "live_slots": server.live_slots,
            "talking_now": talk.live_count(),
            "resume_s": int(talk.RESUME_S),
            "idle_s": int(talk.IDLE_S),
            "frame_ms": 20,
            "mic_sample_rate": 16_000,
            "speech_sample_rate": 24_000,
        },
    }


async def _refuse(ws: WebSocket, code: int, err: str, say: str) -> None:
    try:
        await ws.send_json({"type": "error", "code": err, "say": say, "show": say})
        await ws.close(code=code)
    except Exception:  # noqa: BLE001 - they may already be gone
        pass


async def _hello(ws: WebSocket) -> Hello | None:
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=HELLO_TIMEOUT_S)
        return Hello.model_validate(json.loads(raw))
    except (asyncio.TimeoutError, ValueError, ValidationError, KeyError):
        await _refuse(ws, CLOSE_BAD_HELLO, "bad_hello", "Talk needs a hello first.")
    except (WebSocketDisconnect, RuntimeError):
        pass
    return None


def _uuid(value: str | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(value) if value else None
    except ValueError:
        return None


@router.websocket("/ws")
async def talk_socket(ws: WebSocket) -> None:
    await ws.accept()
    # Signing in and setting up use one short DB session, closed before the
    # conversation starts.
    async with SessionLocal() as db:
        try:
            user, _how = await socket_user(ws, db)
        except NotSignedIn as e:
            await _refuse(ws, e.code, "not_signed_in" if e.code == CLOSE_UNAUTHORIZED else "forbidden", e.message)
            return
        server = await access.server_talk(db)
        refused = await access.refusal(db, user, server)
    from app.billing.usage_context import bill_usage_to
    from app.logging_setup import bind_user

    bill_usage_to(user.id)
    bind_user(user.id)
    if refused is not None:
        await _refuse(ws, CLOSE_FORBIDDEN, "talk_off", refused)
        return

    hello = await _hello(ws)
    if hello is None:
        return
    transport = WebSocketTransport(ws)

    resume_id = _uuid(ws.query_params.get("resume"))
    found = talk.find(resume_id) if resume_id else None
    if found is not None and found.user.id == user.id:
        session = found
        await session.attach(transport, resumed=True)
    else:
        if talk.live_count() >= server.live_slots:
            await _refuse(ws, CLOSE_BUSY, "busy", links.BUSY)
            return
        prefs = access.voice_prefs(user)
        conv_param = ws.query_params.get("conversation_id")
        conversation_id = _uuid(conv_param)
        if conv_param and conversation_id is None:
            await _refuse(ws, CLOSE_NOT_FOUND, "not_found", "That chat doesn't exist.")
            return
        try:
            conv = await chat.open_conversation(
                user, conversation_id=conversation_id, phone=hello.phone, temporary=prefs.save == "temporary"
            )
        except LookupError:
            await _refuse(ws, CLOSE_NOT_FOUND, "not_found", "That chat doesn't exist.")
            return
        except chat.TurnRefused as e:
            await _refuse(ws, CLOSE_UNAVAILABLE, "no_model", e.say)
            return
        session = talk.TalkSession(user=user, hello=hello, conv=conv, prefs=prefs, connection=_Connection(ws))
        try:
            await session.start(transport)
        except links.SpeechUnavailable as e:
            await session.tts_http.aclose()
            if conv.ephemeral:
                await chat.forget_conversation(conv)
            code = CLOSE_BUSY if e.say == links.BUSY else CLOSE_UNAVAILABLE
            await _refuse(ws, code, "busy" if code == CLOSE_BUSY else "speech_unavailable", e.say)
            return

    try:
        while not session.ended:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                if len(data) > MAX_FRAME_BYTES:
                    continue
                await session.client_audio(data)
                continue
            text = message.get("text")
            if not text:
                continue
            try:
                parsed = json.loads(text)
            except ValueError:
                continue
            if not isinstance(parsed, dict):
                continue
            if parsed.get("type") == "ping":
                # Answered here, not by the session's actor, so the round
                # trip measures the connection (the web's weak-connection
                # check), not how busy the conversation is.
                await transport.send_json({"type": "pong", "t": parsed.get("t")})
                continue
            session.client_message(parsed)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        transport.closed = True
        session.detach(transport)

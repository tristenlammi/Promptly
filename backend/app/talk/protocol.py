"""The ``/api/talk/ws`` protocol (WP-T2), and the transport seam.

Connect
    ``/api/talk/ws?conversation_id=<uuid>&resume=<session_id>`` (both optional).
    Signed in by, in order: an ``Authorization: Basic`` app password with the
    ``assistant`` scope (the phone), an ``Authorization: Bearer`` access token
    (native clients), or a one-use Talk ticket from ``POST /api/talk/ticket``,
    sent as the ``promptly_talk`` cookie that call sets (browsers, which can't
    put headers on a WebSocket) or as ``?ticket=``.
    ``conversation_id`` must be your own chat, else the socket closes 4404 (the
    same as one that doesn't exist). It's ignored on the phone, whose
    conversations aren't saved.

Client -> server, JSON text
    ``hello {codec: pcm16|opus, sample_rate, play: pcm16|opus, device:
    web|android|car, caps: [...], tz, lang, turn_mode: hands_free|tap,
    interrupt_mode: talk|tap, trip?}`` first, within 10 s.
    ``mute``, ``unmute``, ``interrupt {played_ms?}`` (stop it talking; say how
    much you played if you know), ``end_turn`` (tap to talk: I've finished),
    ``confirm {answer: yes|no}``, ``text {words}`` (Type instead), ``bye``.
Client -> server, binary
    4-byte big-endian sequence number + one Opus packet, or PCM16 mono 16 kHz.

Server -> client, JSON text
    ``ready {session_id, conversation_id, resumed, audio: {format, sample_rate,
    frame_ms}, limits}``, ``state {state: listening|thinking|speaking|muted,
    muted}``, ``partial {text}`` (your words so far), ``heard {text,
    message_id}`` (what was taken as your turn), ``reply {text, message_id?}``
    (its words so far, cleaned for speech), ``spoken {chars}`` (how much of
    ``reply.text`` has started playing), ``tool {label}``, ``card {kind,
    message_id, meta}``, ``ask {question, approval_id, expires_in}``,
    ``action {type, ...}``, ``stop_audio``, ``error {code, say, show}``,
    ``bye {reason}``.
Server -> client, binary
    4-byte sequence number + one 20 ms frame of speech at 24 kHz (an Opus
    packet, or 960 bytes of PCM16 mono), sent at playing pace.

Close codes: 4400 bad hello, 4401 not signed in, 4403 Talk isn't on for you,
4404 no such conversation, 4429 too many people talking, 4503 speech or model
not available.

``TalkSession`` (``session.py``) only sees a :class:`Transport`, so another
carrier (a LiveKit participant, later) is an adapter, not a rewrite.
"""
from __future__ import annotations

import asyncio
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field, field_validator

PROTOCOL_VERSION = 1

CLOSE_BAD_HELLO = 4400
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_BUSY = 4429
CLOSE_UNAVAILABLE = 4503

DEVICES = ("web", "android", "car")
CAPS = ("timer", "alarm", "dial", "message", "open_app", "navigate")


class Hello(BaseModel):
    type: Literal["hello"] = "hello"
    codec: Literal["pcm16", "opus"] = "pcm16"
    sample_rate: int = 16_000
    play: Literal["pcm16", "opus"] | None = None
    device: Literal["web", "android", "car"] = "web"
    caps: list[str] = Field(default_factory=list, max_length=16)
    tz: str | None = Field(default=None, max_length=64)
    lang: str | None = Field(default=None, max_length=16)
    turn_mode: Literal["hands_free", "tap"] | None = None
    interrupt_mode: Literal["talk", "tap"] | None = None
    trip: dict[str, Any] | None = None

    @field_validator("caps")
    @classmethod
    def _known_caps(cls, v: list[str]) -> list[str]:
        return [c for c in dict.fromkeys(v) if c in CAPS]

    @field_validator("sample_rate")
    @classmethod
    def _rate(cls, v: int) -> int:
        if v != 16_000:
            raise ValueError("Talk listens at 16 kHz")
        return v

    @property
    def phone(self) -> bool:
        return self.device in ("android", "car")

    @property
    def play_format(self) -> str:
        return self.play or self.codec


class Transport(Protocol):
    """Where a Talk session's events and speech go."""

    async def send_json(self, data: dict[str, Any]) -> None: ...

    async def send_bytes(self, data: bytes) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


class WebSocketTransport:
    """A Starlette WebSocket as a Transport. One send at a time (speech frames
    and events come from different tasks); a closed socket swallows sends."""

    def __init__(self, ws) -> None:  # noqa: ANN001 - starlette.websockets.WebSocket
        self.ws = ws
        self._lock = asyncio.Lock()
        self.closed = False

    async def send_json(self, data: dict[str, Any]) -> None:
        if self.closed:
            return
        try:
            async with self._lock:
                await self.ws.send_json(data)
        except Exception:  # noqa: BLE001 - the receive loop notices the drop
            self.closed = True

    async def send_bytes(self, data: bytes) -> None:
        if self.closed:
            return
        try:
            async with self._lock:
                await self.ws.send_bytes(data)
        except Exception:  # noqa: BLE001
            self.closed = True

    async def close(self, code: int = 1000) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            async with self._lock:
                await self.ws.close(code=code)
        except Exception:  # noqa: BLE001
            pass

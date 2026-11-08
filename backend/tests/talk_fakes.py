"""Test doubles for Talk (WP-T2): a scripted speech-sidecar pair, a scripted
model, and a WebSocket client that drives the real app in the test's loop.

* :class:`FakeSidecars` runs two real HTTP servers (uvicorn, in this event
  loop, on free localhost ports): a whisper with ``WS /live`` whose events the
  test scripts, and a tts with ``POST /tts/stream`` that streams PCM, 40 ms of
  speech per word, and notes when it's hung up on. Talk reaches them over the
  network exactly as it reaches the real ones.
* :func:`model` replaces the chat generator's provider call.
* :class:`TalkClient` speaks ASGI to ``app.main.app`` directly, so the socket,
  its auth and the chat pipeline all run in the test's loop with its database.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from app.models_config.provider import FinishEvent, TextDelta, UsageEvent

FRAME = 960  # 20 ms of PCM16 at 24 kHz
FRAMES_PER_WORD = 2


class FakeLive:
    def __init__(self, ws: WebSocket, query: dict[str, str]) -> None:
        self.ws = ws
        self.query = query
        self.audio = bytearray()
        self.frames = 0
        self.commands: list[str] = []
        self.closed = asyncio.Event()

    async def emit(self, event: dict[str, Any]) -> None:
        await self.ws.send_text(json.dumps(event))

    async def say(self, turn: int, text: str, *, partials: bool = True, gap: float = 0.0) -> None:
        """A whole utterance, the way whisper reports one."""
        await self.emit({"type": "speech_start", "turn": turn, "at_ms": 0})
        if partials:
            words = text.split()
            for n in range(2, len(words) + 1, 2):
                await self.emit({"type": "partial", "turn": turn, "text": " ".join(words[:n]), "stable": ""})
        if gap:
            await asyncio.sleep(gap)
        await self.emit({"type": "turn_end", "turn": turn, "reason": "complete", "probability": 0.9, "silence_ms": 250, "speech_end_ms": 1000, "at_ms": 1280})
        await self.emit({"type": "final", "turn": turn, "text": text, "language": "en", "pass_ms": 300, "wait_ms": 200, "reused": True})


class FakeSidecars:
    def __init__(self) -> None:
        self.lives: list[FakeLive] = []
        self._new_live = asyncio.Event()
        self.spoken: list[str] = []  # texts asked for, in order
        self.tts_bodies: list[dict[str, Any]] = []
        self.tts_hung_up = 0
        self.tts_finished = 0
        self.tts_delay = 0.03
        self.refuse_live: dict[str, Any] | None = None
        self._servers: list[uvicorn.Server] = []
        self._tasks: list[asyncio.Task] = []
        self.whisper_url = ""
        self.tts_url = ""

    def _whisper_app(self) -> FastAPI:
        app = FastAPI()

        @app.websocket("/live")
        async def live(ws: WebSocket) -> None:
            await ws.accept()
            if self.refuse_live is not None:
                await ws.send_text(json.dumps(self.refuse_live))
                await ws.close(code=self.refuse_live.get("code", 4503))
                return
            session = FakeLive(ws, dict(ws.query_params))
            self.lives.append(session)
            await ws.send_text(json.dumps({"type": "ready", "model": "base", "sample_rate": 16000, "codec": session.query.get("codec"), "smart_turn": True}))
            self._new_live.set()
            try:
                while True:
                    msg = await ws.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if msg.get("bytes") is not None:
                        session.audio += msg["bytes"]
                        session.frames += 1
                    elif msg.get("text"):
                        session.commands.append(json.loads(msg["text"]).get("type"))
            except WebSocketDisconnect:
                pass
            finally:
                session.closed.set()

        return app

    def _tts_app(self) -> FastAPI:
        app = FastAPI()

        @app.post("/tts/stream")
        async def stream(body: dict) -> StreamingResponse:
            self.spoken.append(body["text"])
            self.tts_bodies.append(body)
            words = len(body["text"].split())
            tail = int(body.get("tail_ms") or 0) * 48

            async def audio():
                done = False
                try:
                    await asyncio.sleep(self.tts_delay)  # "making" the piece
                    for i in range(words * FRAMES_PER_WORD):
                        yield bytes([i % 251 + 1]) * FRAME
                    if tail:
                        yield b"\x00" * tail
                    done = True
                finally:
                    if done:
                        self.tts_finished += 1
                    else:
                        self.tts_hung_up += 1

            return StreamingResponse(audio(), media_type="application/octet-stream")

        return app

    async def _serve(self, app: FastAPI) -> str:
        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="off", ws="websockets")
        server = uvicorn.Server(config)
        server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
        task = asyncio.create_task(server.serve())
        self._servers.append(server)
        self._tasks.append(task)
        for _ in range(500):
            if server.started:
                break
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}"

    async def start(self) -> "FakeSidecars":
        self.whisper_url = await self._serve(self._whisper_app())
        self.tts_url = await self._serve(self._tts_app())
        return self

    async def stop(self) -> None:
        for s in self._servers:
            s.should_exit = True
        for t in self._tasks:
            try:
                await asyncio.wait_for(t, timeout=5)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                t.cancel()

    async def live(self, n: int = 1, timeout: float = 5.0) -> FakeLive:
        """The n-th /live session (1-based), once it's open."""
        deadline = time.monotonic() + timeout
        while len(self.lives) < n:
            if time.monotonic() > deadline:
                raise AssertionError("whisper /live was never opened")
            self._new_live.clear()
            try:
                await asyncio.wait_for(self._new_live.wait(), timeout=0.1)
            except asyncio.TimeoutError:
                pass
        return self.lives[n - 1]


class Model:
    """The provider, scripted: each call takes the next reply (or repeats the
    last), after ``ttft`` seconds, a word at a time."""

    def __init__(self, replies: list[str], *, ttft: float = 0.05, per_word: float = 0.0) -> None:
        self.replies = list(replies)
        self.ttft = ttft
        self.per_word = per_word
        self.calls: list[list[dict[str, Any]]] = []
        self.cancelled = 0

    async def __call__(self, **kwargs):
        messages = kwargs.get("messages") or []
        if any("Respond with only the title" in str(_content(m)) for m in messages):
            # The chat titler's side call, not a reply.
            yield TextDelta(text="A title")
            yield FinishEvent(reason="stop")
            return
        self.calls.append(messages)
        text = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        done = False
        try:
            await asyncio.sleep(self.ttft)
            words = text.split(" ")
            for i, w in enumerate(words):
                yield TextDelta(text=w if i == 0 else " " + w)
                if self.per_word:
                    await asyncio.sleep(self.per_word)
            yield UsageEvent(prompt_tokens=20, completion_tokens=len(words), cost_usd=0.0)
            yield FinishEvent(reason="stop")
            done = True
        finally:
            if not done:
                self.cancelled += 1

    def last_user_text(self, call: int = -1) -> str:
        msgs = [m for m in self.calls[call] if _role(m) == "user"]
        content = _content(msgs[-1]) if msgs else ""
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        return str(content)


def _role(m: Any) -> str:
    return m.get("role") if isinstance(m, dict) else getattr(m, "role", "")


def _content(m: Any) -> Any:
    return m.get("content") if isinstance(m, dict) else getattr(m, "content", "")


class Closed(Exception):
    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


class TalkClient:
    """A WebSocket client for ``/api/talk/ws`` over ASGI, in this loop."""

    def __init__(self, app, *, query: str = "", headers: dict[str, str] | None = None, cookies: dict[str, str] | None = None) -> None:
        raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
        if cookies:
            raw.append((b"cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()).encode()))
        raw.append((b"host", b"test"))
        self._in: asyncio.Queue = asyncio.Queue()
        self._out: asyncio.Queue = asyncio.Queue()
        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0"},
            "scheme": "ws",
            "http_version": "1.1",
            "path": "/api/talk/ws",
            "raw_path": b"/api/talk/ws",
            "query_string": query.encode(),
            "root_path": "",
            "headers": raw,
            "client": ("127.0.0.1", 50000),
            "server": ("test", 80),
            "subprotocols": [],
            "state": {},
        }
        self._task = asyncio.create_task(app(scope, self._in.get, self._out.put))
        self.events: list[dict[str, Any]] = []
        self.audio: list[bytes] = []
        self.log: list[tuple[float, str]] = []  # (time, kind) of everything received
        self.closed: int | None = None
        self._seq = 0

    async def connect(self) -> None:
        await self._in.put({"type": "websocket.connect"})
        msg = await asyncio.wait_for(self._out.get(), timeout=10)
        if msg["type"] == "websocket.close":
            raise Closed(msg.get("code", 1000))
        assert msg["type"] == "websocket.accept", msg

    async def hello(self, **fields: Any) -> dict[str, Any]:
        await self.send({"type": "hello", "codec": "pcm16", "sample_rate": 16000, "device": "web", **fields})
        return await self.expect("ready")

    async def send(self, data: dict[str, Any]) -> None:
        await self._in.put({"type": "websocket.receive", "text": json.dumps(data)})

    async def mic(self, payload: bytes) -> None:
        await self._in.put({"type": "websocket.receive", "bytes": self._seq.to_bytes(4, "big") + payload})
        self._seq += 1

    async def drop(self) -> None:
        await self._in.put({"type": "websocket.disconnect", "code": 1006})
        try:
            await asyncio.wait_for(self._task, timeout=5)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            pass

    async def _next(self, timeout: float) -> dict[str, Any] | bytes:
        while True:
            msg = await asyncio.wait_for(self._out.get(), timeout=timeout)
            now = time.monotonic()
            if msg["type"] == "websocket.close":
                self.closed = msg.get("code", 1000)
                self.log.append((now, "close"))
                raise Closed(self.closed)
            if msg["type"] != "websocket.send":
                continue
            if msg.get("bytes") is not None:
                self.audio.append(msg["bytes"])
                self.log.append((now, "audio"))
                return msg["bytes"]
            event = json.loads(msg["text"])
            self.events.append(event)
            self.log.append((now, event["type"] + (":" + str(event.get("state")) if event["type"] == "state" else "")))
            return event

    async def expect(self, kind: str, timeout: float = 10.0, **match: Any) -> dict[str, Any]:
        """Read until an event of ``kind`` (matching ``match``) arrives."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            try:
                if left <= 0:
                    raise asyncio.TimeoutError
                item = await self._next(left)
            except asyncio.TimeoutError:
                tail = [k for k in self.kinds() if k != "audio"][-20:]
                errors = [e for e in self.events if e.get("type") == "error"]
                raise AssertionError(f"no {kind} {match or ''}; got {tail}; errors {errors}") from None
            if isinstance(item, dict) and item.get("type") == kind and all(item.get(k) == v for k, v in match.items()):
                return item

    async def find(self, kind: str, timeout: float = 10.0, **match: Any) -> dict[str, Any]:
        """Like ``expect``, but an event already received counts too."""
        for event in self.events:
            if event.get("type") == kind and all(event.get(k) == v for k, v in match.items()):
                return event
        return await self.expect(kind, timeout, **match)

    async def until_audio(self, timeout: float = 10.0) -> bytes:
        deadline = time.monotonic() + timeout
        while True:
            item = await self._next(max(0.01, deadline - time.monotonic()))
            if isinstance(item, bytes):
                return item

    async def drain(self, seconds: float) -> None:
        """Read whatever comes for ``seconds``."""
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return
            try:
                await self._next(left)
            except asyncio.TimeoutError:
                return

    async def closed_with(self, timeout: float = 10.0) -> int:
        try:
            while True:
                await self._next(timeout)
        except Closed as c:
            return c.code

    def kinds(self) -> list[str]:
        return [k for _, k in self.log]


def bearer(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def new_id() -> str:
    return str(uuid.uuid4())

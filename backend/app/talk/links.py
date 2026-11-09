"""Talk's two links to the speech services (WP-T2).

* :class:`LiveStt`: a WebSocket to whisper ``/live`` (``whisper/server.py``,
  the protocol in the comment above ``live_socket``). Microphone frames go in
  as they arrive; ``speech_start``, ``partial``, ``turn_end``, ``final`` and
  ``dropped`` come back.
* :func:`speak`: one ``POST /tts/stream`` per piece of a reply, read as 20 ms
  frames while Kokoro makes them. Leaving the loop hangs up, which stops the
  sidecar after the piece it's on.

Both only ever log sizes and timings, never words.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import urlencode

import httpx

from app.config import get_settings

from .audio import OpusDeframer, PcmFramer

logger = logging.getLogger("promptly.talk")

UNAVAILABLE = "Voice isn't available on this server right now."
BUSY = "Too many people are talking to Promptly right now. Try again in a minute."


class SpeechUnavailable(Exception):
    def __init__(self, say: str = UNAVAILABLE, *, code: int | None = None) -> None:
        super().__init__(say)
        self.say = say
        self.code = code


def _live_url(codec: str, language: str | None) -> str:
    base = (get_settings().WHISPER_URL or "").rstrip("/")
    if not base:
        raise SpeechUnavailable()
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    query = {"codec": codec}
    if language:
        query["language"] = language
    return f"{base}/live?{urlencode(query)}"


class LiveStt:
    """One conversation's live link to Whisper. Events go to ``on_event`` in
    order; a link that dies sends ``{"type": "link_lost"}``."""

    def __init__(self, *, codec: str, language: str | None, on_event: Callable[[dict[str, Any]], Awaitable[None] | None]) -> None:
        self.codec = codec
        self.language = language
        self._on_event = on_event
        self._ws = None
        self._reader: asyncio.Task | None = None
        self._send_lock = asyncio.Lock()
        self.closed = False
        self.bytes_sent = 0

    async def open(self, timeout: float = 8.0) -> dict[str, Any]:
        from websockets.asyncio.client import connect

        url = _live_url(self.codec, self.language)
        try:
            self._ws = await asyncio.wait_for(
                connect(url, max_size=1 << 20, open_timeout=timeout, ping_interval=20, ping_timeout=20),
                timeout=timeout,
            )
            first = json.loads(await asyncio.wait_for(self._ws.recv(), timeout=timeout))
        except SpeechUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - any failure here means no live speech
            logger.warning("talk: whisper /live unreachable (%s)", type(exc).__name__)
            await self._drop()
            raise SpeechUnavailable() from None
        if first.get("type") != "ready":
            code = first.get("code")
            await self._drop()
            raise SpeechUnavailable(BUSY if code == 1013 else UNAVAILABLE, code=code)
        self._reader = asyncio.create_task(self._read(), name="talk-stt-reader")
        return first

    async def _read(self) -> None:
        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    continue
                try:
                    event = json.loads(message)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    result = self._on_event(event)
                    if asyncio.iscoroutine(result):
                        await result
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.info("talk: whisper link ended (%s)", type(exc).__name__)
        if not self.closed:
            self.closed = True
            result = self._on_event({"type": "link_lost"})
            if asyncio.iscoroutine(result):
                await result

    async def audio(self, data: bytes) -> None:
        if self.closed or self._ws is None or not data:
            return
        try:
            async with self._send_lock:
                await self._ws.send(data)
            self.bytes_sent += len(data)
        except Exception:  # noqa: BLE001 - the reader reports the lost link
            pass

    async def command(self, kind: str) -> None:
        if self.closed or self._ws is None:
            return
        try:
            async with self._send_lock:
                await self._ws.send(json.dumps({"type": kind}))
        except Exception:  # noqa: BLE001
            pass

    async def _drop(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    async def close(self) -> None:
        self.closed = True
        reader, self._reader = self._reader, None
        await self._drop()
        if reader is not None and not reader.done():
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


def tts_client() -> httpx.AsyncClient:
    timeout = max(5, int(get_settings().TTS_TIMEOUT_S or 60))
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=5.0))


async def speak(
    client: httpx.AsyncClient,
    text: str,
    *,
    voice: str | None,
    speed: float,
    fmt: str,
    tail_ms: int,
) -> AsyncIterator[bytes]:
    """The frames of one piece of speech as Kokoro makes them (``fmt``:
    ``opus`` packets or 20 ms ``pcm16`` frames, 24 kHz mono)."""
    base = (get_settings().TTS_URL or "").rstrip("/")
    if not base:
        raise SpeechUnavailable()
    body = {
        "text": text,
        "voice": voice or get_settings().TTS_VOICE or None,
        "speed": speed,
        "format": "opus" if fmt == "opus" else "pcm",
        "first_clause": False,  # the backend already cut it short
        "tail_ms": tail_ms,
    }
    framer = OpusDeframer() if fmt == "opus" else PcmFramer()
    try:
        async with client.stream("POST", f"{base}/tts/stream", json=body) as resp:
            if resp.status_code != 200:
                await resp.aread()
                logger.warning("talk: tts refused a piece (%s)", resp.status_code)
                raise SpeechUnavailable()
            async for chunk in resp.aiter_raw():
                for frame in framer.push(chunk):
                    yield frame
        for frame in framer.flush():
            yield frame
    except httpx.HTTPError as exc:
        logger.warning("talk: tts unreachable (%s)", type(exc).__name__)
        raise SpeechUnavailable() from None

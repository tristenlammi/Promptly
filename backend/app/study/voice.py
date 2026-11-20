"""Whether lessons can be read aloud and answered by speaking on this server.

Study uses the app's own voice pieces (``/api/voice/tts`` for reading a step
out, ``/api/voice/transcribe`` for a spoken answer). They are optional
containers, so the lesson player asks here first and shows nothing about
voice when they aren't running. The answer is kept for two minutes.
"""
from __future__ import annotations

import time

import httpx

from app.config import get_settings

_TTL = 120.0
_cache: tuple[float, dict[str, bool]] | None = None


async def _up(base: str) -> bool:
    base = (base or "").rstrip("/")
    if not base:
        return False
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            return (await client.get(f"{base}/health")).status_code == 200
    except httpx.HTTPError:
        return False


async def available(*, fresh: bool = False) -> dict[str, bool]:
    """``{"listen": steps can be read aloud, "speak": answers can be dictated}``."""
    global _cache
    now = time.monotonic()
    if not fresh and _cache is not None and now - _cache[0] < _TTL:
        return _cache[1]
    s = get_settings()
    cloud = (s.STT_BACKEND or "local").strip().lower() != "local"
    out = {"listen": await _up(s.TTS_URL), "speak": cloud or await _up(s.WHISPER_URL)}
    _cache = (now, out)
    return out

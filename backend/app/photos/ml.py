"""The photos-ml service, from the backend's side (PH-2, Part E §E4.2).

``PHOTOS_ML_URL`` (default ``http://photos-ml:8000``; started by compose by
default). When it isn't running, or is still downloading its
models, the stages that need it wait — they're not failed — and Photos says
so.
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from app.config import get_settings

_HEALTH_TTL = 30.0
_health: tuple[float, dict[str, Any] | None] = (0.0, None)


def base_url() -> str:
    return (get_settings().PHOTOS_ML_URL or "").rstrip("/")


async def health(*, fresh: bool = False) -> dict[str, Any] | None:
    """The service's ``/health`` (``state``, ``model``, …), or None when it
    isn't there. Cached for 30 s."""
    global _health
    url = base_url()
    if not url:
        return None
    stamp, cached = _health
    if not fresh and time.monotonic() - stamp < _HEALTH_TTL:
        return cached
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url + "/health")
            got = r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        got = None
    _health = (time.monotonic(), got)
    return got


async def waiting() -> str | None:
    """Why understanding that needs the service can't run now, or None."""
    h = await health()
    if h is None:
        return "Photo search isn't set up (the photos-ml service isn't running)"
    if h.get("state") == "downloading":
        total = h.get("bytes_total") or 0
        pct = int(100 * (h.get("bytes_done") or 0) / total) if total else 0
        return f"Downloading the photo models ({pct}%)"
    if h.get("state") != "ready":
        return "The photo models are loading" if h.get("state") in ("starting", "loading") else (
            f"The photo models couldn't be prepared: {h.get('error') or 'unknown error'}"
        )
    return None


async def faces_waiting() -> str | None:
    """Why faces can't be found now, or None. Asks the service to load its
    face models the first time (they're only loaded once someone wants them)."""
    reason = await waiting()
    if reason:
        return reason
    h = await health() or {}
    state = (h.get("faces") or {}).get("state")
    if state == "ready":
        return None
    if state in (None, "idle", "error"):
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(base_url() + "/v1/faces/prepare")
        except httpx.HTTPError:
            pass
        await health(fresh=True)
    if state == "error":
        return f"The face models couldn't be prepared: {(h.get('faces') or {}).get('error') or 'unknown error'}"
    return "Getting the face models ready"


async def animals_waiting() -> str | None:
    """Why animals can't be found now, or None (asks the service to load
    the animal models the first time)."""
    reason = await waiting()
    if reason:
        return reason
    h = await health() or {}
    state = (h.get("animals") or {}).get("state")
    if state == "ready":
        return None
    if state in (None, "idle", "error"):
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(base_url() + "/v1/animals/prepare")
        except httpx.HTTPError:
            pass
        await health(fresh=True)
    if state == "error":
        return f"The animal models couldn't be prepared: {(h.get('animals') or {}).get('error') or 'unknown error'}"
    return "Getting the animal models ready"


async def _group_waiting(key: str, prepare_path: str, what: str) -> str | None:
    reason = await waiting()
    if reason:
        return reason
    h = await health() or {}
    state = (h.get(key) or {}).get("state")
    if state == "ready":
        return None
    if state in (None, "idle", "error"):
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(base_url() + prepare_path)
        except httpx.HTTPError:
            pass
        await health(fresh=True)
    if state == "error":
        return f"The {what} models couldn't be prepared: {(h.get(key) or {}).get('error') or 'unknown error'}"
    return f"Getting the {what} models ready"


async def text_waiting() -> str | None:
    return await _group_waiting("text", "/v1/text/prepare", "text-reading")


async def find_text(images: list[bytes]) -> tuple[str, list[dict[str, Any] | None]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)) as client:
        r = await client.post(
            base_url() + "/v1/text",
            files=[("files", (f"{i}.webp", data, "image/webp")) for i, data in enumerate(images)],
        )
        r.raise_for_status()
        body = r.json()
    return body["model"], body["texts"]


async def find_animals(images: list[bytes]) -> tuple[str, list[list[dict[str, Any]] | None]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)) as client:
        r = await client.post(
            base_url() + "/v1/animals",
            files=[("files", (f"{i}.webp", data, "image/webp")) for i, data in enumerate(images)],
        )
        r.raise_for_status()
        body = r.json()
    return body["model"], body["animals"]


async def find_faces(images: list[bytes]) -> tuple[str, list[list[dict[str, Any]] | None]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)) as client:
        r = await client.post(
            base_url() + "/v1/faces",
            files=[("files", (f"{i}.webp", data, "image/webp")) for i, data in enumerate(images)],
        )
        r.raise_for_status()
        body = r.json()
    return body["model"], body["faces"]


async def embed_images(images: list[bytes]) -> tuple[str, list[list[float] | None]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0)) as client:
        r = await client.post(
            base_url() + "/v1/embed/images",
            files=[("files", (f"{i}.webp", data, "image/webp")) for i, data in enumerate(images)],
        )
        r.raise_for_status()
        body = r.json()
    return body["model"], body["vectors"]


async def embed_texts(texts: list[str]) -> tuple[str, list[list[float]]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
        r = await client.post(base_url() + "/v1/embed/texts", json={"texts": texts})
        r.raise_for_status()
        body = r.json()
    return body["model"], body["vectors"]


__all__ = ["animals_waiting", "base_url", "embed_images", "embed_texts", "faces_waiting", "find_animals", "find_faces", "find_text", "health", "text_waiting", "waiting"]

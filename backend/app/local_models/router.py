"""Local Models (Ollama) admin module.

Phase 2 surface of the Models admin page. This module is a thin
wrapper over the Ollama REST API running inside the bundled
``Promptly-Ollama`` container — it does not embed any business
logic in the protocol itself, just authenticates the caller as an
admin, normalises the response shapes, and streams long-running
operations (model pulls) to the UI.

Endpoints (all mounted under ``/api/admin/local-models``):

- ``GET  /installed`` — models currently on disk.
- ``GET  /library``   — curated manifest of suggested models with
                        VRAM/RAM hints.
- ``GET  /hardware``  — probe the host for GPU/CPU/RAM specs so
                        the UI can render the "will it run?" badge.
- ``POST /pull``      — SSE-streamed ``/api/pull``. Progress events
                        mirror the upstream shape plus a final
                        ``{"done": true}`` terminator.
- ``DELETE /installed/{name}`` — remove a pulled model.
- ``POST /refresh-provider`` — reconcile the auto-registered Ollama
                               ``ModelProvider.models`` list so
                               pulled models appear in the picker.
"""
from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db
from app.local_models.hardware import probe_hardware
from app.local_models.library import LIBRARY, LibraryEntry
from app.models_config.models import ModelProvider

log = logging.getLogger(__name__)


def _ollama_base_url() -> str:
    """Internal-network URL of the bundled Ollama container."""
    return os.environ.get("OLLAMA_URL", "http://ollama:11434").rstrip("/")


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


class InstalledModel(BaseModel):
    """One row in ``GET /api/tags`` normalised for the UI."""

    name: str
    size_bytes: int | None = None
    modified_at: str | None = None
    digest: str | None = None
    family: str | None = None
    parameter_size: str | None = None
    quantization: str | None = None


class HardwareProbe(BaseModel):
    cpu_count: int
    total_ram_bytes: int
    has_nvidia: bool
    gpus: list[dict] = Field(default_factory=list)


class PullRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


router = APIRouter()


@router.get("/installed", response_model=list[InstalledModel])
async def list_installed(
    _user: User = Depends(require_admin),
) -> list[InstalledModel]:
    """Proxy ``GET /api/tags`` and normalise into our DTO shape."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.get(f"{_ollama_base_url()}/api/tags")
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Ollama unreachable: {e}",
            )

    raw = r.json().get("models", [])
    out: list[InstalledModel] = []
    for m in raw:
        details = m.get("details") or {}
        out.append(
            InstalledModel(
                name=m.get("name", ""),
                size_bytes=m.get("size"),
                modified_at=m.get("modified_at"),
                digest=m.get("digest"),
                family=details.get("family"),
                parameter_size=details.get("parameter_size"),
                quantization=details.get("quantization_level"),
            )
        )
    return out


@router.get("/library", response_model=list[LibraryEntry])
async def get_library(
    _user: User = Depends(require_admin),
) -> list[LibraryEntry]:
    """Return the curated list of recommended Ollama models.

    Shipped as a static manifest so the Local Models tab can render
    "will this run on your hardware?" badges without scraping
    ollama.com on every page load.
    """
    return LIBRARY


@router.get("/hardware", response_model=HardwareProbe)
async def hardware(
    _user: User = Depends(require_admin),
) -> HardwareProbe:
    return probe_hardware()


@router.delete("/installed/{name:path}")
async def delete_installed(
    name: str,
    _user: User = Depends(require_admin),
) -> dict[str, bool]:
    """Delete a locally-installed model.

    ``name:path`` converter so tags that include a ``:`` (the vast
    majority — ``llama3.1:8b``) round-trip intact.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.request(
                "DELETE",
                f"{_ollama_base_url()}/api/delete",
                json={"name": name},
            )
            if r.status_code == 404:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Model not installed: {name}",
                )
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Ollama unreachable: {e}",
            )
    return {"ok": True}


@router.post("/pull")
async def pull_model(
    payload: PullRequest,
    _user: User = Depends(require_admin),
) -> StreamingResponse:
    """Stream a model pull as Server-Sent Events.

    Ollama emits one JSON object per line with ``status``, optional
    ``total``/``completed`` bytes, etc. We forward each line as
    a ``data: <json>`` SSE event and close with a terminator so the
    UI can stop listening cleanly.
    """

    async def stream() -> AsyncIterator[str]:
        url = f"{_ollama_base_url()}/api/pull"
        payload_dict = {"name": payload.name, "stream": True}
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", url, json=payload_dict) as r:
                    if r.status_code >= 400:
                        body = await r.aread()
                        err = body.decode("utf-8", errors="replace")[:500]
                        yield _sse(
                            {"error": True, "status_code": r.status_code, "detail": err}
                        )
                        yield _sse({"done": True})
                        return
                    async for line in r.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        # Upstream sends JSONL; forward as-is after
                        # validating it's JSON (so a malformed line
                        # doesn't poison the EventSource parser).
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        yield _sse(obj)
                        if obj.get("error"):
                            break
                    yield _sse({"done": True})
        except httpx.HTTPError as e:
            yield _sse({"error": True, "detail": str(e)})
            yield _sse({"done": True})

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/refresh-provider")
async def refresh_provider(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_admin),
) -> dict[str, int]:
    """Reconcile the auto-registered Ollama provider's ``models`` list.

    Pulled models don't magically appear in ``list_available_models_for``
    — providers cache their ``models`` column. Call this endpoint after
    a successful pull (or on-demand from the UI) to rebuild the cache
    so the newly-pulled model shows up in the chat picker immediately.

    If no Ollama provider row exists yet, this becomes a no-op and
    returns ``{"created": 0, "models": 0}``. Use the
    ``/api/admin/custom-models/bootstrap-local-embedding`` endpoint to
    create the provider row first.
    """
    installed = await list_installed(_user=_user)  # type: ignore[arg-type]

    result = await db.execute(
        select(ModelProvider).where(
            ModelProvider.user_id.is_(None),
            ModelProvider.type == "ollama",
        )
    )
    provider = result.scalar_one_or_none()
    if provider is None:
        return {"created": 0, "models": 0}

    # Local import to avoid a top-level cycle with the custom_models
    # package (which itself imports from models_config).
    from app.custom_models.embedding import is_embedding_model_id

    provider.models = [
        {
            "id": m.name,
            "display_name": m.name,
            "context_window": None,
            "supports_vision": False,
            # Tag embedding-only backbones so ``list_available_models_for``
            # can hide them from the chat picker without re-running the
            # name heuristic. Preserves the same shape other providers
            # use (``{"kind": "embedding"}``).
            **({"kind": "embedding"} if is_embedding_model_id(m.name) else {}),
        }
        for m in installed
    ]
    await db.commit()
    return {"created": 1, "models": len(provider.models)}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"

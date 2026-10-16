"""Local Models (Ollama) admin module.

Phase 2 surface of the Models admin page. This module is a thin
wrapper over the Ollama REST API running inside the bundled
``Promptly-Ollama`` container — it does not embed any business
logic in the protocol itself, just authenticates the caller as an
admin, normalises the response shapes, and streams long-running
operations (model pulls) to the UI.

Endpoints (all mounted under ``/api/admin/local-models``):

- ``GET  /installed`` — models currently on disk.
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
    # "detected" (nvidia-smi saw it), "in_use" (Ollama has models in
    # VRAM), "none", or "unknown" — the backend container usually can't
    # see the GPU at all, so "unknown" is the honest default (R-279).
    gpu_status: str = "unknown"
    ollama_vram_bytes: int = 0
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


@router.get("/hardware", response_model=HardwareProbe)
async def hardware(
    _user: User = Depends(require_admin),
) -> HardwareProbe:
    return await probe_hardware(_ollama_base_url())


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
) -> dict:
    """Reconcile every Ollama provider's ``models`` list.

    Pulled models don't magically appear in ``list_available_models_for``
    — providers cache their ``models`` column. Call this endpoint after
    a successful pull (or on-demand from the UI) to rebuild the cache
    so the newly-pulled model shows up in the chat picker immediately.

    If no Ollama provider row exists yet, this becomes a no-op and
    returns ``{"created": 0, "models": 0}``. Use the
    ``/api/admin/custom-models/bootstrap-local-embedding`` endpoint to
    create the provider row first.
    """
    # Every Ollama provider, not just the system one: models pulled for an
    # admin-added Ollama provider never appeared, and a second row made
    # ``scalar_one_or_none`` 500 (R-300).
    from app.custom_models.embedding import is_embedding_model_id
    from app.models_config.provider import model_router

    rows = list(
        (await db.execute(select(ModelProvider).where(ModelProvider.type == "ollama"))).scalars()
    )
    if not rows:
        return {"created": 0, "models": 0, "providers": []}
    report = []
    for provider in rows:
        try:
            catalog = await model_router.list_models(provider)
        except Exception as e:  # noqa: BLE001 — one unreachable Ollama mustn't stop the rest
            report.append({"id": str(provider.id), "name": provider.name, "ok": False, "error": str(e)[:200]})
            continue
        for m in catalog:
            # Tag embedding-only backbones so the chat picker hides them.
            if is_embedding_model_id(m.get("id", "")):
                m["kind"] = "embedding"
        provider.models = catalog
        report.append({"id": str(provider.id), "name": provider.name, "ok": True, "models": len(catalog)})
    await db.commit()
    return {
        "created": 1,
        "models": sum(r.get("models", 0) for r in report),
        "providers": report,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"

"""Admin-only CRUD for Custom Models + the workspace embedding config.

Mounted at ``/api/admin/custom-models`` so it sits alongside the
existing ``/api/admin/providers`` (model connections) endpoints. The
auth gate is the same :func:`require_admin` dependency every other
admin-only route uses — non-admin callers get a 403 without ever
seeing the route exists.

Surface area:

* ``GET    /``                              — list assistants
* ``POST   /``                              — create
* ``GET    /{id}``                          — full row + file rows
* ``PATCH  /{id}``                          — partial update
* ``DELETE /{id}``                          — delete (cascades chunks)
* ``POST   /{id}/files``                    — attach file ids; queues indexing
* ``DELETE /{id}/files/{file_id}``          — detach + drop chunks
* ``POST   /{id}/files/{file_id}/reindex``  — manual retry button

Embedding-provider management (workspace setting):

* ``GET    /embedding-config``              — current setting
* ``PUT    /embedding-config``              — set/clear

The chat picker integration (extending ``list_available_models_for``)
lives in :mod:`app.models_config.router` so the picker contract stays
in one place.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Iterable

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import require_admin
from app.auth.models import User
from app.custom_models.embedding import (
    KNOWN_EMBEDDING_DIMS,
    SUPPORTED_DIMS,
    embed_texts,
    embedding_dim_for,
)
from app.custom_models.ingestion import (
    index_file_for_custom_model,
    reembed_custom_model,
)
from app.custom_models.models import (
    CustomModel,
    CustomModelFile,
    KnowledgeChunk,
)
from app.custom_models.schemas import (
    AttachFilesRequest,
    CustomModelCreate,
    CustomModelDetail,
    CustomModelSummary,
    CustomModelUpdate,
    EmbeddingConfig,
    EmbeddingConfigTestResult,
    EmbeddingConfigUpdate,
    KnowledgeFile,
)
from app.database import get_db
from app.files.models import UserFile
from app.models_config.models import ModelProvider

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_or_404(
    custom_model_id: uuid.UUID, db: AsyncSession
) -> CustomModel:
    cm = await db.get(CustomModel, custom_model_id)
    if cm is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Custom model not found",
        )
    return cm


async def _resolve_base_display_name(
    base_provider_id: uuid.UUID,
    base_model_id: str,
    db: AsyncSession,
) -> str | None:
    """Look up the human label for a custom model's underlying base model."""
    provider = await db.get(ModelProvider, base_provider_id)
    if provider is None:
        return None
    for entry in provider.models or []:
        if entry.get("id") == base_model_id:
            return entry.get("display_name") or base_model_id
    return base_model_id


async def _validate_base_model(
    base_provider_id: uuid.UUID,
    base_model_id: str,
    db: AsyncSession,
) -> None:
    """Reject create/update payloads that point at a non-existent base model.

    Catches the common typo of an admin pasting a model id that
    isn't in the provider's catalog (or pointing at a provider that
    no longer exists).
    """
    provider = await db.get(ModelProvider, base_provider_id)
    if provider is None or not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="base_provider_id does not refer to an enabled provider",
        )
    catalog_ids = {m.get("id") for m in (provider.models or [])}
    if base_model_id not in catalog_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"base_model_id {base_model_id!r} is not in the catalog of "
                f"provider {provider.name!r}"
            ),
        )


async def _summarise(
    cm: CustomModel, db: AsyncSession
) -> CustomModelSummary:
    """Render a row for the list view (one round-trip per row to count
    files + ready files; cheap at the expected scale of dozens of
    custom models per workspace)."""
    file_count = (
        await db.execute(
            select(sa_func.count(CustomModelFile.user_file_id)).where(
                CustomModelFile.custom_model_id == cm.id
            )
        )
    ).scalar_one()
    ready_count = (
        await db.execute(
            select(sa_func.count(CustomModelFile.user_file_id)).where(
                CustomModelFile.custom_model_id == cm.id,
                CustomModelFile.indexing_status == "ready",
            )
        )
    ).scalar_one()
    base_label = await _resolve_base_display_name(
        cm.base_provider_id, cm.base_model_id, db
    )
    return CustomModelSummary(
        id=cm.id,
        name=cm.name,
        display_name=cm.display_name,
        description=cm.description,
        base_provider_id=cm.base_provider_id,
        base_model_id=cm.base_model_id,
        base_display_name=base_label,
        file_count=int(file_count or 0),
        ready_file_count=int(ready_count or 0),
        top_k=cm.top_k,
        created_at=cm.created_at,
        updated_at=cm.updated_at,
    )


async def _build_file_rows(
    cm: CustomModel, db: AsyncSession
) -> list[KnowledgeFile]:
    """Join ``custom_model_files`` to ``files`` + chunk counts."""
    rows = (
        await db.execute(
            select(
                CustomModelFile,
                UserFile,
                sa_func.count(KnowledgeChunk.id).label("chunk_count"),
            )
            .join(UserFile, UserFile.id == CustomModelFile.user_file_id)
            .outerjoin(
                KnowledgeChunk,
                (KnowledgeChunk.user_file_id == CustomModelFile.user_file_id)
                & (KnowledgeChunk.custom_model_id == cm.id),
            )
            .where(CustomModelFile.custom_model_id == cm.id)
            .group_by(CustomModelFile.user_file_id, UserFile.id, CustomModelFile.custom_model_id)
            .order_by(CustomModelFile.added_at.desc())
        )
    ).all()
    out: list[KnowledgeFile] = []
    for pivot, file, chunk_count in rows:
        out.append(
            KnowledgeFile(
                user_file_id=pivot.user_file_id,
                filename=file.original_filename or file.filename,
                mime_type=file.mime_type,
                size_bytes=file.size_bytes,
                indexing_status=pivot.indexing_status,
                indexing_error=pivot.indexing_error,
                indexed_at=pivot.indexed_at,
                added_at=pivot.added_at,
                chunk_count=int(chunk_count or 0),
            )
        )
    return out


async def _detail(
    cm: CustomModel, db: AsyncSession
) -> CustomModelDetail:
    summary = await _summarise(cm, db)
    files = await _build_file_rows(cm, db)
    return CustomModelDetail(
        **summary.model_dump(),
        personality=cm.personality,
        files=files,
    )


def _queue_initial_indexing(
    background: BackgroundTasks,
    *,
    custom_model_id: uuid.UUID,
    file_ids: Iterable[uuid.UUID],
) -> None:
    """Schedule one ingestion task per attached file.

    FastAPI's ``BackgroundTasks`` runs after the response is sent, so
    a multi-file create returns 201 instantly while the embed work
    proceeds in the background.
    """
    for fid in file_ids:
        background.add_task(index_file_for_custom_model, custom_model_id, fid)


# ---------------------------------------------------------------------------
# CustomModel CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[CustomModelSummary])
@router.get("/", response_model=list[CustomModelSummary], include_in_schema=False)
async def list_custom_models(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> list[CustomModelSummary]:
    """List every custom model in the workspace (admin only)."""
    rows = (
        await db.execute(select(CustomModel).order_by(CustomModel.created_at.desc()))
    ).scalars().all()
    return [await _summarise(cm, db) for cm in rows]


@router.post(
    "",
    response_model=CustomModelDetail,
    status_code=status.HTTP_201_CREATED,
)
@router.post(
    "/",
    response_model=CustomModelDetail,
    status_code=status.HTTP_201_CREATED,
    include_in_schema=False,
)
async def create_custom_model(
    payload: CustomModelCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> CustomModelDetail:
    await _validate_base_model(payload.base_provider_id, payload.base_model_id, db)

    # Slug uniqueness is enforced by the DB; we pre-check so the user
    # gets a friendly 409 instead of a generic IntegrityError 500.
    existing = (
        await db.execute(select(CustomModel).where(CustomModel.name == payload.name))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A custom model with name {payload.name!r} already exists",
        )

    cm = CustomModel(
        name=payload.name,
        display_name=payload.display_name,
        description=payload.description,
        personality=payload.personality,
        base_provider_id=payload.base_provider_id,
        base_model_id=payload.base_model_id,
        top_k=payload.top_k,
        created_by=user.id,
    )
    db.add(cm)
    await db.flush()

    if payload.file_ids:
        await _attach_files(cm.id, payload.file_ids, db, background)

    await db.commit()
    await db.refresh(cm)
    return await _detail(cm, db)


# --------------------------------------------------------------------
# Workspace embedding-provider config + bootstrap helpers.
#
# NOTE: these literal-path routes MUST be declared before the
# ``/{custom_model_id}`` section below. FastAPI/Starlette path
# matching is strictly first-match, and a UUID-typed path param
# will 422 on a non-UUID string like ``embedding-config`` instead
# of falling through to a later literal route.
# --------------------------------------------------------------------


@router.get("/embedding-config", response_model=EmbeddingConfig)
async def get_embedding_config(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> EmbeddingConfig:
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        return EmbeddingConfig()
    provider_name: str | None = None
    if settings.embedding_provider_id:
        provider = await db.get(ModelProvider, settings.embedding_provider_id)
        provider_name = provider.name if provider else None
    return EmbeddingConfig(
        embedding_provider_id=settings.embedding_provider_id,
        embedding_model_id=settings.embedding_model_id,
        embedding_dim=settings.embedding_dim,
        embedding_provider_name=provider_name,
    )


@router.put("/embedding-config", response_model=EmbeddingConfig)
async def set_embedding_config(
    payload: EmbeddingConfigUpdate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> EmbeddingConfig:
    """Pick (or clear) the workspace's embedding provider.

    When the admin actually changes the dimension, every existing
    knowledge chunk is now in the wrong vector column. We queue a
    re-embed of every custom model in the background so the
    knowledge libraries catch up — the UI will show "embedding…"
    chips again until it finishes.
    """
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        # The singleton row should have been seeded by the initial
        # migration; if it hasn't, refuse to lazily create it here —
        # something is structurally wrong and silently inserting it
        # would mask the real issue.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="App settings singleton row is missing; run migrations",
        )

    # Clearing — both fields go to NULL together, no provider lookup.
    if payload.embedding_provider_id is None:
        settings.embedding_provider_id = None
        settings.embedding_model_id = None
        settings.embedding_dim = None
        await db.commit()
        return EmbeddingConfig()

    if not payload.embedding_model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="embedding_model_id is required when embedding_provider_id is set",
        )

    provider = await db.get(ModelProvider, payload.embedding_provider_id)
    if provider is None or not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="embedding_provider_id does not refer to an enabled provider",
        )

    # Resolve the dim. Caller-provided wins (admin knows best); else
    # fall back to our table; else probe the provider with a single
    # short embed call.
    dim = payload.embedding_dim or embedding_dim_for(payload.embedding_model_id)
    if dim is None:
        try:
            probe = await embed_texts(
                provider=provider,
                model_id=payload.embedding_model_id,
                texts=["x"],
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"could not probe embedding dimension: {exc}",
            ) from exc
        if not probe:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="embedding provider returned no vectors",
            )
        dim = len(probe[0])

    if dim not in SUPPORTED_DIMS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"embedding model produces dim={dim}, which has no vector "
                f"column in this database. Supported dims: {sorted(SUPPORTED_DIMS)}. "
                f"Add a column in a follow-up migration to enable other dims."
            ),
        )

    dim_changed = settings.embedding_dim != dim
    settings.embedding_provider_id = provider.id
    settings.embedding_model_id = payload.embedding_model_id
    settings.embedding_dim = dim
    await db.commit()

    # Re-embed every existing custom model when the dim flips so the
    # knowledge libraries don't silently fall out of the vector index.
    if dim_changed:
        cm_ids = (
            await db.execute(select(CustomModel.id))
        ).scalars().all()
        for cm_id in cm_ids:
            background.add_task(reembed_custom_model, cm_id)

    return EmbeddingConfig(
        embedding_provider_id=provider.id,
        embedding_model_id=payload.embedding_model_id,
        embedding_dim=dim,
        embedding_provider_name=provider.name,
    )


@router.post(
    "/embedding-config/test",
    response_model=EmbeddingConfigTestResult,
)
async def test_embedding_config(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> EmbeddingConfigTestResult:
    """End-to-end smoke test of the active embedding provider.

    Runs a single ``embed_texts`` call against the provider currently
    stored in ``AppSettings`` with a short, well-known probe string.
    The response is always HTTP 200 so the UI can render both success
    and failure states inline — the ``ok`` field distinguishes them.

    Catches and surfaces:

    * no embedding provider configured
    * provider row missing / disabled (stale config)
    * network / auth errors from the upstream (wrong API key,
      Ollama container down, model not pulled, etc.)
    * zero-length or wrong-dim vector responses

    Does not mutate state — safe to call as often as the admin wants.
    """
    import time

    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if (
        settings is None
        or not settings.embedding_provider_id
        or not settings.embedding_model_id
    ):
        return EmbeddingConfigTestResult(
            ok=False,
            error=(
                "No embedding provider is configured. Click Change and pick "
                "either the bundled local Ollama runtime or an API provider."
            ),
        )

    provider = await db.get(ModelProvider, settings.embedding_provider_id)
    if provider is None:
        return EmbeddingConfigTestResult(
            ok=False,
            embedding_provider_id=settings.embedding_provider_id,
            embedding_model_id=settings.embedding_model_id,
            error=(
                "Configured embedding provider no longer exists. Reconfigure "
                "the embedding choice from the Custom Models panel."
            ),
        )
    if not provider.enabled:
        return EmbeddingConfigTestResult(
            ok=False,
            embedding_provider_id=provider.id,
            embedding_model_id=settings.embedding_model_id,
            embedding_provider_name=provider.name,
            error=(
                f'Provider "{provider.name}" is disabled. Enable it in the '
                "Connections tab or pick a different embedding provider."
            ),
        )

    probe_text = "Promptly embedding connectivity probe."
    start = time.perf_counter()
    try:
        vectors = await embed_texts(
            provider=provider,
            model_id=settings.embedding_model_id,
            texts=[probe_text],
        )
    except Exception as exc:  # noqa: BLE001 — surface any upstream error
        latency_ms = int((time.perf_counter() - start) * 1000)
        logger.warning(
            "embedding test failed: provider=%s model=%s err=%s",
            provider.name,
            settings.embedding_model_id,
            exc,
        )
        return EmbeddingConfigTestResult(
            ok=False,
            embedding_provider_id=provider.id,
            embedding_model_id=settings.embedding_model_id,
            embedding_provider_name=provider.name,
            latency_ms=latency_ms,
            error=str(exc) or type(exc).__name__,
        )
    latency_ms = int((time.perf_counter() - start) * 1000)

    if not vectors or not vectors[0]:
        return EmbeddingConfigTestResult(
            ok=False,
            embedding_provider_id=provider.id,
            embedding_model_id=settings.embedding_model_id,
            embedding_provider_name=provider.name,
            latency_ms=latency_ms,
            error="Provider returned no vectors for the probe string.",
        )

    vec = vectors[0]
    return EmbeddingConfigTestResult(
        ok=True,
        embedding_provider_id=provider.id,
        embedding_model_id=settings.embedding_model_id,
        embedding_provider_name=provider.name,
        dimension=len(vec),
        latency_ms=latency_ms,
        sample=[float(x) for x in vec[:5]],
    )


@router.get("/{custom_model_id:uuid}", response_model=CustomModelDetail)
async def get_custom_model(
    custom_model_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> CustomModelDetail:
    cm = await _get_or_404(custom_model_id, db)
    return await _detail(cm, db)


@router.patch("/{custom_model_id:uuid}", response_model=CustomModelDetail)
async def update_custom_model(
    custom_model_id: uuid.UUID,
    payload: CustomModelUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> CustomModelDetail:
    cm = await _get_or_404(custom_model_id, db)

    fields = payload.model_fields_set
    if "display_name" in fields and payload.display_name is not None:
        cm.display_name = payload.display_name
    if "description" in fields:
        cm.description = payload.description
    if "personality" in fields:
        cm.personality = payload.personality
    if "top_k" in fields and payload.top_k is not None:
        cm.top_k = payload.top_k

    # Base model swaps are validated together so we can't end up
    # half-pointed at a new provider with a stale model id.
    new_provider_id = payload.base_provider_id if "base_provider_id" in fields else cm.base_provider_id
    new_model_id = payload.base_model_id if "base_model_id" in fields else cm.base_model_id
    if (
        new_provider_id != cm.base_provider_id
        or new_model_id != cm.base_model_id
    ):
        if new_provider_id is None or new_model_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="base_provider_id and base_model_id must change together",
            )
        await _validate_base_model(new_provider_id, new_model_id, db)
        cm.base_provider_id = new_provider_id
        cm.base_model_id = new_model_id

    cm.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(cm)
    return await _detail(cm, db)


@router.delete(
    "/{custom_model_id:uuid}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_custom_model(
    custom_model_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> Response:
    cm = await _get_or_404(custom_model_id, db)
    await db.delete(cm)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Knowledge file attach / detach / reindex
# ---------------------------------------------------------------------------


async def _attach_files(
    custom_model_id: uuid.UUID,
    file_ids: Iterable[uuid.UUID],
    db: AsyncSession,
    background: BackgroundTasks,
) -> list[uuid.UUID]:
    """Insert pivot rows + queue ingestion. Skips files already attached.

    Returns the list of file ids that were *newly* attached so the
    caller can shape the response accordingly.
    """
    requested = list(dict.fromkeys(file_ids))  # de-dupe, keep order
    if not requested:
        return []

    # Validate the source files exist before we start inserting pivots.
    found_rows = (
        await db.execute(select(UserFile.id).where(UserFile.id.in_(requested)))
    ).scalars().all()
    found = set(found_rows)
    missing = [fid for fid in requested if fid not in found]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"file_ids not found: {[str(m) for m in missing]}",
        )

    # Skip already-attached pairs so the call is idempotent.
    existing_rows = (
        await db.execute(
            select(CustomModelFile.user_file_id).where(
                CustomModelFile.custom_model_id == custom_model_id,
                CustomModelFile.user_file_id.in_(requested),
            )
        )
    ).scalars().all()
    existing = set(existing_rows)

    new_ids = [fid for fid in requested if fid not in existing]
    for fid in new_ids:
        db.add(
            CustomModelFile(
                custom_model_id=custom_model_id,
                user_file_id=fid,
                indexing_status="queued",
            )
        )
    await db.flush()
    _queue_initial_indexing(
        background, custom_model_id=custom_model_id, file_ids=new_ids
    )
    return new_ids


@router.post(
    "/{custom_model_id:uuid}/files",
    response_model=CustomModelDetail,
    status_code=status.HTTP_201_CREATED,
)
async def attach_files(
    custom_model_id: uuid.UUID,
    payload: AttachFilesRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> CustomModelDetail:
    cm = await _get_or_404(custom_model_id, db)
    await _attach_files(cm.id, payload.file_ids, db, background)
    await db.commit()
    return await _detail(cm, db)


@router.delete(
    "/{custom_model_id:uuid}/files/{user_file_id:uuid}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def detach_file(
    custom_model_id: uuid.UUID,
    user_file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> Response:
    cm = await _get_or_404(custom_model_id, db)
    pivot = await db.get(CustomModelFile, (cm.id, user_file_id))
    if pivot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File is not attached to this custom model",
        )
    await db.delete(pivot)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{custom_model_id:uuid}/files/{user_file_id:uuid}/reindex",
    response_model=KnowledgeFile,
    status_code=status.HTTP_202_ACCEPTED,
)
async def reindex_file(
    custom_model_id: uuid.UUID,
    user_file_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> KnowledgeFile:
    """Manual retry button — useful after a transient embedding failure."""
    cm = await _get_or_404(custom_model_id, db)
    pivot = await db.get(CustomModelFile, (cm.id, user_file_id))
    if pivot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File is not attached to this custom model",
        )
    pivot.indexing_status = "queued"
    pivot.indexing_error = None
    await db.commit()
    background.add_task(
        index_file_for_custom_model, cm.id, user_file_id, force=True
    )
    file = await db.get(UserFile, user_file_id)
    return KnowledgeFile(
        user_file_id=user_file_id,
        filename=(file.original_filename or file.filename) if file else None,
        mime_type=file.mime_type if file else None,
        size_bytes=file.size_bytes if file else None,
        indexing_status=pivot.indexing_status,
        indexing_error=pivot.indexing_error,
        indexed_at=pivot.indexed_at,
        added_at=pivot.added_at,
        chunk_count=0,
    )


# ---------------------------------------------------------------------------
# Read-only helpers exposed to the setup wizard / admin UI
# ---------------------------------------------------------------------------


@router.get("/embedding-models/known")
async def list_known_embedding_models(
    user: User = Depends(require_admin),
) -> dict[str, int]:
    """Return the static "we know this model emits N-dim vectors" table.

    Used by the setup wizard + Custom Models panel to render a
    curated dropdown without baking the same lookup table into the
    frontend bundle. Always JSON-safe; no DB hit.

    Declared after the ``/{custom_model_id:uuid}`` section; safe
    because the ``uuid`` path converter refuses to match the literal
    ``embedding-models`` / ``bootstrap-local-embedding`` strings and
    Starlette falls through to the next registered route.
    """
    return dict(KNOWN_EMBEDDING_DIMS)


@router.post("/bootstrap-local-embedding", response_model=EmbeddingConfig)
async def bootstrap_local_embedding(
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
) -> EmbeddingConfig:
    """Spin up the bundled Ollama provider + point embedding-config at it.

    Safe to call multiple times:

    * If the internal Ollama provider already exists (recognised by
      ``type='ollama'`` + its well-known internal base URL), it's
      reused instead of duplicated.
    * If the workspace already has an embedding config, it's
      overwritten with the local one — callers (the setup wizard or
      the admin "change embedding" dialog) use this when the admin
      explicitly picks "local".
    * When the active embedding dimension changes as a result of the
      switch, every existing custom model is re-embedded in the
      background so its knowledge library stays queryable.
    """
    import os

    # Internal network URL — set by the ``OLLAMA_URL`` env var in
    # ``docker-compose.yml`` and defaulted to the docker-internal
    # hostname. We append ``/v1`` because the provider types go
    # through the OpenAI-compat shim and expect a v1 base.
    internal_base = os.environ.get("OLLAMA_URL", "http://ollama:11434")
    internal_base = internal_base.rstrip("/")
    base_url_v1 = f"{internal_base}/v1"
    default_model = os.environ.get(
        "OLLAMA_DEFAULT_EMBEDDING_MODEL", "nomic-embed-text"
    )

    # Reuse an existing internal Ollama provider when one is present
    # so the admin doesn't end up with duplicate "Ollama (Local)"
    # rows every time they re-run the wizard.
    existing_row = (
        await db.execute(
            select(ModelProvider).where(
                ModelProvider.type == "ollama",
                ModelProvider.base_url == base_url_v1,
            )
        )
    ).scalar_one_or_none()

    if existing_row is None:
        provider = ModelProvider(
            user_id=None,  # system-wide — visible to every user
            name="Ollama (Local)",
            type="ollama",
            base_url=base_url_v1,
            api_key=None,
            enabled=True,
            # Seed the catalog with the embedding model id so the
            # dim probe / downstream embed calls have a target even
            # before the admin visits the Local Models UI to pull
            # chat models.
            models=[
                {
                    "id": default_model,
                    "display_name": default_model,
                    "context_window": None,
                    "kind": "embedding",
                }
            ],
        )
        db.add(provider)
        await db.flush()
    else:
        provider = existing_row
        # Make sure the embedding model id is present in the catalog
        # so ``_validate_base_model`` accepts it when / if the admin
        # later wraps it in a custom model. Idempotent.
        catalog = provider.models or []
        if not any(m.get("id") == default_model for m in catalog):
            provider.models = catalog + [
                {
                    "id": default_model,
                    "display_name": default_model,
                    "context_window": None,
                    "kind": "embedding",
                }
            ]

    # Point the workspace config at it.
    settings_row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings_row is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="App settings singleton row is missing; run migrations",
        )
    dim = embedding_dim_for(default_model) or 768
    if dim not in SUPPORTED_DIMS:
        # nomic-embed-text is 768 which is in SUPPORTED_DIMS, but be
        # explicit about the constraint so a future default swap
        # surfaces loudly instead of writing rows into a column that
        # doesn't exist.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"default embedding model {default_model!r} emits dim={dim} "
                f"which isn't in the supported vector columns {sorted(SUPPORTED_DIMS)}"
            ),
        )
    dim_changed = settings_row.embedding_dim != dim
    settings_row.embedding_provider_id = provider.id
    settings_row.embedding_model_id = default_model
    settings_row.embedding_dim = dim
    await db.commit()

    # If the dim flipped (e.g. switching from a 1536-dim OpenAI model
    # to 768-dim nomic-embed-text) the existing knowledge chunks land
    # in the wrong vector column, so re-embed every custom model in
    # the background the same way the generic PUT endpoint does.
    if dim_changed:
        cm_ids = (
            await db.execute(select(CustomModel.id))
        ).scalars().all()
        for cm_id in cm_ids:
            background.add_task(reembed_custom_model, cm_id)

    return EmbeddingConfig(
        embedding_provider_id=provider.id,
        embedding_model_id=default_model,
        embedding_dim=dim,
        embedding_provider_name=provider.name,
    )

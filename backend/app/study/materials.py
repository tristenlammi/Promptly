"""Study materials: background indexing, text extraction for planning,
and retrieval for session context injection."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.custom_models.embedding import (
    extract_text_for_embedding,
    is_text_extractable,
)
from app.custom_models.ingestion import embed_file_to_chunks, delete_existing_chunks, insert_chunks
from app.custom_models.retrieval import format_retrieved_block, retrieve_study_context
from app.chat.semantic_search import get_embedding_config
from app.database import SessionLocal
from app.files.models import UserFile
from app.study.models import StudyMaterial

logger = logging.getLogger(__name__)

# Max characters of raw material text injected into the planner prompt.
# ~8 000 chars ≈ 2 000 tokens, comfortable inside the planning budget.
_PLANNING_MAX_CHARS = 8_000

# Number of chunks retrieved per tutor turn.
_SESSION_TOP_K = 5


async def index_material_for_study_project(
    study_project_id: uuid.UUID,
    user_file_id: uuid.UUID,
) -> None:
    """Background task: embed a study material file into ``knowledge_chunks``.

    Owns its own DB session so it is safe to run on FastAPI
    ``BackgroundTasks``. Mirrors :func:`app.chat.project_knowledge.index_file_for_project`.
    """
    async with SessionLocal() as db:
        try:
            material_res = await db.execute(
                select(StudyMaterial).where(
                    StudyMaterial.study_project_id == study_project_id,
                    StudyMaterial.user_file_id == user_file_id,
                )
            )
            material = material_res.scalar_one_or_none()
            if material is None:
                return

            uf = await db.get(UserFile, user_file_id)
            if uf is None:
                material.indexing_status = "failed"
                material.indexing_error = "source file no longer exists"
                await db.commit()
                return

            if not is_text_extractable(uf):
                # Binary / image files are not RAG candidates.
                material.indexing_status = "failed"
                material.indexing_error = "file type not supported for text extraction"
                await db.commit()
                return

            cfg = await get_embedding_config(db)
            if cfg is None:
                # No embedding provider configured — leave pending so a
                # later retry picks it up once the admin sets one up.
                return

            material.indexing_status = "indexing"
            await db.commit()

            try:
                chunks, embeddings = await embed_file_to_chunks(
                    uf,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except (ValueError, RuntimeError) as exc:
                material.indexing_status = "failed"
                material.indexing_error = str(exc)[:255]
                await db.commit()
                return

            await delete_existing_chunks(
                db,
                scope_kind="study_project",
                scope_id=study_project_id,
                user_file_id=user_file_id,
            )
            await insert_chunks(
                db,
                scope_kind="study_project",
                scope_id=study_project_id,
                user_file_id=user_file_id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            material.indexing_status = "ready"
            material.indexed_at = datetime.now(timezone.utc)
            await db.commit()
            logger.info(
                "indexed %d chunks for study_project=%s file=%s",
                len(chunks),
                study_project_id,
                user_file_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "index_material_for_study_project failed study_project=%s file=%s",
                study_project_id,
                user_file_id,
            )
            try:
                material_res2 = await db.execute(
                    select(StudyMaterial).where(
                        StudyMaterial.study_project_id == study_project_id,
                        StudyMaterial.user_file_id == user_file_id,
                    )
                )
                mat2 = material_res2.scalar_one_or_none()
                if mat2 is not None and mat2.indexing_status not in ("ready",):
                    mat2.indexing_status = "failed"
                    mat2.indexing_error = "unexpected error during indexing"
                    await db.commit()
            except Exception:  # noqa: BLE001
                pass


async def extract_material_text_for_planning(
    db: AsyncSession,
    study_project_id: uuid.UUID,
) -> str:
    """Extract raw text from all materials attached to a study project for
    use in the planning prompt.

    Returns empty string when there are no materials or extraction fails.
    Caps total output at ``_PLANNING_MAX_CHARS`` to stay inside the
    planner's token budget.
    """
    materials_res = await db.execute(
        select(StudyMaterial).where(
            StudyMaterial.study_project_id == study_project_id,
        )
    )
    materials = list(materials_res.scalars().all())
    if not materials:
        return ""

    parts: list[str] = []
    remaining = _PLANNING_MAX_CHARS
    for mat in materials:
        uf = await db.get(UserFile, mat.user_file_id)
        if uf is None:
            continue
        if not is_text_extractable(uf):
            continue
        try:
            text = extract_text_for_embedding(uf)
        except Exception:  # noqa: BLE001
            continue
        if not text:
            continue
        trimmed = text[:remaining]
        label = uf.original_filename or uf.filename or "material"
        parts.append(f"[{label}]\n{trimmed}")
        remaining -= len(trimmed)
        if remaining <= 0:
            break

    return "\n\n---\n\n".join(parts)


async def retrieve_for_study_session(
    db: AsyncSession,
    study_project_id: uuid.UUID,
    query: str,
) -> str:
    """Retrieve the top-K most relevant material chunks for a tutor turn.

    Returns an empty string (no error) when no materials are indexed or
    the embedding provider is unavailable — graceful degradation.
    """
    chunks = await retrieve_study_context(
        db,
        study_project_id=study_project_id,
        query=query,
        top_k=_SESSION_TOP_K,
    )
    if not chunks:
        return ""
    return format_retrieved_block(chunks)

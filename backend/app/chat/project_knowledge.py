"""Hybrid retrieval over a Chat Project's pinned files.

Small projects keep injecting their pinned files in full (today's
behaviour — the model sees every byte). Once a project accumulates more
pinned *text* than :data:`PROJECT_RETRIEVAL_TOKEN_BUDGET`, it flips to
top-k semantic retrieval: only the chunks most relevant to the current
turn are spliced into the system prompt, so a 200-page pinned spec no
longer blows the context window on every message.

This module owns three concerns:

* **Ingestion** (:func:`index_file_for_project` /
  :func:`delete_project_file_chunks`) — enqueued from the pin/unpin
  endpoints. Reuses the scope-agnostic chunk store + embed pipeline in
  :mod:`app.custom_models.ingestion`; the only project-specific part is
  the indexing-lifecycle bookkeeping on ``chat_project_files``.

* **Injection** (:func:`build_project_injection`) — the per-send
  decision: full-dump vs. retrieve, and which files still need to ride
  the attachment/vision path (images always; text files that aren't
  indexed yet as a fallback).

* **Budget stats** (:func:`project_context_stats`) — what the project
  detail page shows so the user understands the per-turn context tax.

Everything degrades gracefully when embeddings aren't configured: the
injection path returns "full-dump everything", exactly as before.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import ChatProject, ChatProjectFile, Conversation, Message
from app.chat.semantic_search import get_embedding_config
from app.models_config.models import ModelProvider
from app.custom_models.embedding import (
    file_content_hash,
    is_text_extractable,
)
from app.custom_models.ingestion import (
    delete_existing_chunks,
    embed_file_to_chunks,
    insert_chunks,
)
from app.custom_models.models import KnowledgeChunk
from app.custom_models.retrieval import (
    format_retrieved_block,
    retrieve_project_context,
)
from app.database import SessionLocal
from app.files.models import UserFile

logger = logging.getLogger("promptly.chat.project_knowledge")

# Once a project's indexed text passes this many tokens, new chats in it
# switch from full-dump to top-k retrieval. ~6k tokens is roughly a
# dozen pages — comfortably under any modern context window, so smaller
# projects keep the simpler "model sees everything" behaviour.
PROJECT_RETRIEVAL_TOKEN_BUDGET = 6000

# Chunks pulled per turn when retrieval is active. Matches the Custom
# Models default; ~6 * 500-token chunks ≈ 3k tokens of grounded context.
PROJECT_RETRIEVAL_TOP_K = 6


def _estimate_tokens(text: str | None) -> int:
    """Cheap char/4 token estimate — same heuristic the chunker uses."""
    if not text:
        return 0
    return max(0, len(text) // 4)


# ---------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------


async def _set_project_file_status(
    db: AsyncSession,
    *,
    project_id: uuid.UUID,
    file_id: uuid.UUID,
    status: str,
    error: str | None = None,
    indexed_hash: str | None = None,
) -> None:
    pivot = await db.get(ChatProjectFile, (project_id, file_id))
    if pivot is None:
        return
    pivot.indexing_status = status
    pivot.indexing_error = error
    if status == "ready":
        pivot.indexed_at = datetime.now(timezone.utc)
        if indexed_hash is not None:
            pivot.indexed_content_hash = indexed_hash
    await db.commit()


async def index_file_for_project(
    project_id: uuid.UUID,
    file_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed (or re-embed) a single pinned project file.

    Owns its own DB session so it's safe on a ``BackgroundTasks``
    runner. No-op (status stays ``queued``, no error) when embeddings
    aren't configured — the project just keeps full-dumping until an
    admin sets up an embedding provider, then a re-pin indexes it.
    """
    async with SessionLocal() as db:
        try:
            file = await db.get(UserFile, file_id)
            if file is None:
                await _set_project_file_status(
                    db,
                    project_id=project_id,
                    file_id=file_id,
                    status="failed",
                    error="source file no longer exists",
                )
                return

            # Images / binaries are not RAG candidates — they ride the
            # attachment/vision path. Leave them ``queued`` so they're
            # simply ignored by retrieval (and never marked failed).
            if not is_text_extractable(file):
                return

            cfg = await get_embedding_config(db)
            if cfg is None:
                # No embedding provider yet — leave queued so a later
                # re-pin (after setup) picks it up. Not an error.
                return

            current_hash = file_content_hash(file)
            pivot = await db.get(ChatProjectFile, (project_id, file_id))
            if (
                not force
                and pivot is not None
                and pivot.indexed_content_hash == current_hash
                and pivot.indexing_status == "ready"
            ):
                return

            await _set_project_file_status(
                db, project_id=project_id, file_id=file_id, status="embedding"
            )

            try:
                chunks, embeddings = await embed_file_to_chunks(
                    file,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except ValueError as exc:
                await _set_project_file_status(
                    db,
                    project_id=project_id,
                    file_id=file_id,
                    status="failed",
                    error=str(exc),
                )
                return

            await delete_existing_chunks(
                db, scope_kind="project", scope_id=project_id, user_file_id=file_id
            )
            await insert_chunks(
                db,
                scope_kind="project",
                scope_id=project_id,
                user_file_id=file_id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            await _set_project_file_status(
                db,
                project_id=project_id,
                file_id=file_id,
                status="ready",
                indexed_hash=current_hash,
            )
            logger.info(
                "indexed %d chunks for project=%s file=%s",
                len(chunks),
                project_id,
                file_id,
            )
        except Exception as exc:  # noqa: BLE001 - last-line catch
            logger.exception("index_file_for_project failed")
            try:
                await _set_project_file_status(
                    db,
                    project_id=project_id,
                    file_id=file_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:  # noqa: BLE001
                pass


async def delete_project_file_chunks(
    project_id: uuid.UUID, file_id: uuid.UUID
) -> None:
    """Drop a file's project-scoped chunks (called on unpin). Owns its
    own session so it's safe on a ``BackgroundTasks`` runner."""
    async with SessionLocal() as db:
        await delete_existing_chunks(
            db, scope_kind="project", scope_id=project_id, user_file_id=file_id
        )


async def reindex_project(project_id: uuid.UUID) -> None:
    """Re-index every text file pinned to a project. Used after the
    admin changes the workspace embedding provider (dims would mismatch)."""
    async with SessionLocal() as db:
        rows = await db.execute(
            select(ChatProjectFile.file_id).where(
                ChatProjectFile.project_id == project_id
            )
        )
        file_ids = [r[0] for r in rows.all()]
    for fid in file_ids:
        await index_file_for_project(project_id, fid, force=True)


# ---------------------------------------------------------------------
# Injection (per-send)
# ---------------------------------------------------------------------


@dataclass
class ProjectInjection:
    """What the send path should do with a project's pinned files.

    ``system_block`` — retrieved "Project knowledge" text to splice into
    the system prompt (``None`` in full-dump mode or when nothing
    matched). ``attach_file_ids`` — files to fold into the triggering
    turn's attachments (full-dump mode: everything; retrieval mode:
    images + not-yet-indexed text as a fallback). ``retrieval_active``
    is surfaced for logging / SSE only.
    """

    system_block: str | None = None
    attach_file_ids: list[uuid.UUID] = field(default_factory=list)
    retrieval_active: bool = False


async def _indexed_token_total(db: AsyncSession, project_id: uuid.UUID) -> int:
    total = await db.scalar(
        select(func.coalesce(func.sum(KnowledgeChunk.tokens), 0)).where(
            KnowledgeChunk.project_id == project_id
        )
    )
    return int(total or 0)


async def build_project_injection(
    db: AsyncSession,
    *,
    project_id: uuid.UUID,
    query: str,
    excluded_file_ids: set[uuid.UUID] | None = None,
) -> ProjectInjection:
    """Decide full-dump vs. retrieval for this turn and return the plan.

    Hybrid rule: retrieval kicks in only when embeddings are configured
    AND the project's indexed text exceeds
    :data:`PROJECT_RETRIEVAL_TOKEN_BUDGET`. Otherwise we full-dump every
    pinned file, exactly as the pre-retrieval code did.

    ``excluded_file_ids`` — files the current chat has opted out of
    (per-chat toggle); they're dropped from both the attachment set and
    the retrieved chunks so this conversation never sees them.
    """
    excluded = excluded_file_ids or set()
    rows = (
        await db.execute(
            select(ChatProjectFile, UserFile)
            .join(UserFile, UserFile.id == ChatProjectFile.file_id)
            .where(ChatProjectFile.project_id == project_id)
            .order_by(ChatProjectFile.pinned_at.asc())
        )
    ).all()
    rows = [(cpf, uf) for cpf, uf in rows if uf.id not in excluded]
    if not rows:
        return ProjectInjection()

    cfg = await get_embedding_config(db)
    indexed_tokens = (
        await _indexed_token_total(db, project_id) if cfg is not None else 0
    )
    retrieval_active = (
        cfg is not None and indexed_tokens > PROJECT_RETRIEVAL_TOKEN_BUDGET
    )

    if not retrieval_active:
        # Full-dump: every pinned file rides the attachment path.
        return ProjectInjection(
            attach_file_ids=[uf.id for _, uf in rows], retrieval_active=False
        )

    # Retrieval mode. Ready text files are represented by the retrieved
    # block; everything else (images, binaries, text still indexing or
    # failed) still rides the attachment path so nothing is silently
    # dropped during the indexing window.
    attach_ids = [
        uf.id
        for cpf, uf in rows
        if not (is_text_extractable(uf) and cpf.indexing_status == "ready")
    ]
    chunks = await retrieve_project_context(
        db,
        project_id=project_id,
        query=query,
        # Pull a few extra so post-filtering excluded files still leaves
        # a useful slate.
        top_k=PROJECT_RETRIEVAL_TOP_K + len(excluded),
    )
    if excluded:
        chunks = [c for c in chunks if c.user_file_id not in excluded]
    chunks = chunks[:PROJECT_RETRIEVAL_TOP_K]
    block = format_retrieved_block(chunks) if chunks else None
    return ProjectInjection(
        system_block=block, attach_file_ids=attach_ids, retrieval_active=True
    )


# ---------------------------------------------------------------------
# Budget stats (project detail page)
# ---------------------------------------------------------------------


@dataclass
class ProjectContextStats:
    instruction_tokens: int
    pinned_file_tokens: int
    per_turn_tokens: int
    retrieval_active: bool
    indexing_count: int


async def project_context_stats(
    db: AsyncSession, *, project_id: uuid.UUID, system_prompt: str | None
) -> ProjectContextStats:
    """Compute the per-turn context baseline for the detail page.

    ``per_turn_tokens`` is the honest number: in retrieval mode it's the
    instructions plus a top-k retrieval budget; in full-dump mode it's
    the instructions plus the entire pinned text.
    """
    instruction_tokens = _estimate_tokens(system_prompt)
    pinned_file_tokens = await _indexed_token_total(db, project_id)
    cfg = await get_embedding_config(db)
    retrieval_active = (
        cfg is not None and pinned_file_tokens > PROJECT_RETRIEVAL_TOKEN_BUDGET
    )
    # Files still mid-index — surfaced so the UI can show "indexing N…".
    indexing_count = int(
        await db.scalar(
            select(func.count())
            .select_from(ChatProjectFile)
            .where(
                ChatProjectFile.project_id == project_id,
                ChatProjectFile.indexing_status.in_(("queued", "embedding")),
            )
        )
        or 0
    )
    if retrieval_active:
        # ~top_k chunks of ~500 tokens each, capped by what's indexed.
        per_turn = instruction_tokens + min(
            pinned_file_tokens, PROJECT_RETRIEVAL_TOP_K * 500
        )
    else:
        per_turn = instruction_tokens + pinned_file_tokens
    return ProjectContextStats(
        instruction_tokens=instruction_tokens,
        pinned_file_tokens=pinned_file_tokens,
        per_turn_tokens=per_turn,
        retrieval_active=retrieval_active,
        indexing_count=indexing_count,
    )


# ---------------------------------------------------------------------
# Auto-memory (opt-in)
# ---------------------------------------------------------------------

# Source-kind marker for the single auto-maintained memory file per
# project. Distinct from the manual "Save summary to project" files
# (``chat_summary``) so we can find + replace exactly one of them.
PROJECT_MEMORY_SOURCE_KIND = "project_memory"

# Per-project cooldown so a burst of turns doesn't re-summarise on every
# message. In-memory + best-effort — resets on restart, which is fine
# (worst case is one extra summary after a deploy).
_MEMORY_COOLDOWN_SECONDS = 180.0
_last_memory_run: dict[str, float] = {}

# How many recently-active conversations to pull for cross-chat merging.
# Enough to capture meaningful divergence without blowing the summary
# model's context. The most recent conversation is always included
# (it triggered this refresh) and the others contribute their own
# last-N messages as background material.
_MEMORY_SOURCE_CONV_COUNT = 5
# Max messages pulled from each background conversation. Keeps the
# merged input bounded even for long conversations.
_MEMORY_BG_MSG_LIMIT = 20


def _format_transcript_excerpt(
    messages: list, title: str | None, max_msgs: int = _MEMORY_BG_MSG_LIMIT
) -> str:
    """Render a bounded excerpt of messages for the merged-memory prompt."""
    label = title or "Untitled"
    lines = [f"=== Chat: {label} ==="]
    textual = [m for m in messages if (m.content or "").strip()][-max_msgs:]
    for m in textual:
        role = (m.role or "user").upper()
        content = (m.content or "").strip()
        if not content or m.role == "system":
            continue
        lines.append(f"{role}: {content[:800]}")  # cap per-message to keep prompt bounded
    return "\n\n".join(lines)


_MERGE_SYSTEM_PROMPT = (
    "You are maintaining a rolling 'Project Memory' document that "
    "accumulates knowledge across all chats in a project.\n\n"
    "You will receive excerpts from several recent chats. Your job is "
    "to synthesise them into a single up-to-date memory document.\n\n"
    "Output format (Markdown only, no preamble):\n"
    "- `## Project overview` — one or two sentences: what is this project about?\n"
    "- `## Durable facts` — bulleted list of things that are always true: "
    "tech stack, constraints, preferences, names, versions.\n"
    "- `## Recent decisions` — bulleted: concrete choices made across "
    "recent chats. Include which chat if relevant.\n"
    "- `## Open questions` — bulleted: unresolved threads across any of "
    "the recent chats. Omit if none.\n"
    "- `## Next steps` — bulleted: actions mentioned as upcoming. Omit if none.\n\n"
    "Rules:\n"
    "- Merge and deduplicate — don't repeat the same fact twice.\n"
    "- Prefer the most recent information when chats conflict.\n"
    "- Write in third person: 'The user ...', 'The assistant ...'.\n"
    "- Hard ceiling: under 700 words. Aim for 350-500.\n"
    "- No commentary about this being a summary."
)


async def maybe_refresh_project_memory(conversation_id: uuid.UUID) -> None:
    """Refresh a project's rolling 'Project Memory' by merging the last
    few conversations, when the project has ``auto_memory_enabled``.

    This is a multi-chat upgrade from the original single-chat approach:
    instead of summarising only the triggering chat, it pulls recent
    transcripts from up to :data:`_MEMORY_SOURCE_CONV_COUNT` conversations
    and asks the model to produce a coherent merged document. Knowledge
    accumulates across conversations rather than overwriting.

    Owns its own session (spawned via ``asyncio.create_task`` from the
    stream finalize). Entirely best-effort; every failure path is a
    quiet return. Debounced per project.
    """
    from app.files.generated import GeneratedFileError, persist_generated_file
    from app.models_config.provider import ChatMessage, ProviderError, model_router

    async with SessionLocal() as db:
        conv = await db.get(Conversation, conversation_id)
        if conv is None or conv.project_id is None:
            return
        proj = await db.get(ChatProject, conv.project_id)
        if proj is None or not proj.auto_memory_enabled:
            return

        key = str(proj.id)
        now = time.monotonic()
        if (now - _last_memory_run.get(key, 0.0)) < _MEMORY_COOLDOWN_SECONDS:
            return
        _last_memory_run[key] = now

        # Resolve provider from the triggering conversation.
        if not conv.provider_id or not conv.model_id:
            return
        provider = await db.get(ModelProvider, conv.provider_id)
        if provider is None or not provider.enabled:
            return

        # Pull the last N recently-active conversations in this project
        # (triggering conv always leads the list).
        recent_convs = list(
            (
                await db.execute(
                    select(Conversation)
                    .where(
                        Conversation.project_id == proj.id,
                        Conversation.temporary_mode.is_(None),
                    )
                    .order_by(Conversation.updated_at.desc())
                    .limit(_MEMORY_SOURCE_CONV_COUNT)
                )
            )
            .scalars()
            .all()
        )
        if not recent_convs:
            return

        # Build per-conversation transcripts. Triggering conv is always
        # pulled in full (up to _MEMORY_BG_MSG_LIMIT); older ones also
        # up to the same limit so the merged prompt stays bounded.
        excerpts: list[str] = []
        for c in recent_convs:
            msgs = list(
                (
                    await db.execute(
                        select(Message)
                        .where(Message.conversation_id == c.id)
                        .order_by(Message.created_at.asc())
                    )
                )
                .scalars()
                .all()
            )
            textual = [m for m in msgs if (m.content or "").strip() and m.role != "system"]
            if len(textual) < 2:
                continue
            excerpts.append(_format_transcript_excerpt(textual, c.title))

        if not excerpts:
            return

        merged_input = "\n\n".join(excerpts)

        try:
            chunks: list[str] = []
            async for token in model_router.stream_chat(
                provider=provider,
                model_id=conv.model_id,
                messages=[ChatMessage(role="user", content=merged_input)],
                system=_MERGE_SYSTEM_PROMPT,
                temperature=0.2,
                max_tokens=1500,
            ):
                chunks.append(token)
            memo = "".join(chunks).strip()
        except Exception:  # noqa: BLE001 - ProviderError or any other failure
            logger.debug("auto-memory: merge call failed for project %s", proj.id)
            return

        if not memo:
            return

        owner = await db.get(User, proj.user_id)
        if owner is None:
            return

        conv_count = len(recent_convs)
        body = (
            f"# Project Memory: {proj.title}\n\n"
            f"_Auto-maintained from the last {conv_count} active chat"
            f"{'s' if conv_count > 1 else ''} in this project. "
            "Turn this off in Settings._\n\n"
            f"{memo}\n"
        )

        existing = (
            await db.execute(
                select(UserFile)
                .join(ChatProjectFile, ChatProjectFile.file_id == UserFile.id)
                .where(
                    ChatProjectFile.project_id == proj.id,
                    UserFile.source_kind == PROJECT_MEMORY_SOURCE_KIND,
                )
            )
        ).scalars().first()

        try:
            new_uf = await persist_generated_file(
                db,
                user=owner,
                filename="Project Memory.md",
                mime_type="text/markdown",
                content=body.encode("utf-8"),
                source_kind=PROJECT_MEMORY_SOURCE_KIND,
            )
        except GeneratedFileError:
            return

        db.add(ChatProjectFile(project_id=proj.id, file_id=new_uf.id, pinned_by=owner.id))
        if existing is not None:
            await db.execute(
                delete(ChatProjectFile).where(
                    ChatProjectFile.project_id == proj.id,
                    ChatProjectFile.file_id == existing.id,
                )
            )
            await db.delete(existing)
        proj.updated_at = datetime.now(timezone.utc)
        await db.commit()
        new_id = new_uf.id

    # Index the fresh memory file so it participates in retrieval.
    await index_file_for_project(proj.id, new_id, force=True)
    logger.info(
        "auto-memory refreshed for project %s (merged %d chats)",
        proj.id,
        len(recent_convs),
    )

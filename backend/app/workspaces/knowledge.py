"""Hybrid retrieval over a Workspace's pinned files.

Small workspaces keep injecting their pinned files in full (today's
behaviour — the model sees every byte). Once a workspace accumulates more
pinned *text* than :data:`WORKSPACE_RETRIEVAL_TOKEN_BUDGET`, it flips to
top-k semantic retrieval: only the chunks most relevant to the current
turn are spliced into the system prompt, so a 200-page pinned spec no
longer blows the context window on every message.

This module owns three concerns:

* **Ingestion** (:func:`index_file_for_workspace` /
  :func:`delete_workspace_file_chunks`) — enqueued from the pin/unpin
  endpoints. Reuses the scope-agnostic chunk store + embed pipeline in
  :mod:`app.custom_models.ingestion`; the only workspace-specific part is
  the indexing-lifecycle bookkeeping on ``workspace_files``.

* **Injection** (:func:`build_workspace_injection`) — the per-send
  decision: full-dump vs. retrieve, and which files still need to ride
  the attachment/vision path (images always; text files that aren't
  indexed yet as a fallback).

* **Budget stats** (:func:`workspace_context_stats`) — what the workspace
  detail page shows so the user understands the per-turn context tax.

Everything degrades gracefully when embeddings aren't configured: the
injection path returns "full-dump everything", exactly as before.
"""
from __future__ import annotations

import hashlib
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.models import User
from app.chat.models import (
    Conversation,
    Message,
    Spreadsheet,
    Workspace,
    WorkspaceCanvas,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceTask,
    WorkspaceTaskComment,
)
from app.chat.semantic_search import get_embedding_config
from app.models_config.models import ModelProvider
from app.custom_models.embedding import (
    file_content_hash,
    is_text_extractable,
)
from app.custom_models.ingestion import (
    delete_existing_chunks,
    embed_file_to_chunks,
    embed_text_to_chunks,
    insert_chunks,
)
from app.custom_models.models import KnowledgeChunk
from app.custom_models.retrieval import (
    format_retrieved_block,
    retrieve_workspace_context,
)
from app.database import SessionLocal
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.files.storage import (
    absolute_path,
    ensure_bucket,
    storage_path_for,
)
from app.files.system_folders import get_or_create_subfolder
from app.files.vision_extract import extract_text_via_vision

logger = logging.getLogger("promptly.workspaces.knowledge")

# Once a workspace's indexed text passes this many tokens, new chats in it
# switch from full-dump to top-k retrieval. ~6k tokens is roughly a
# dozen pages — comfortably under any modern context window, so smaller
# workspaces keep the simpler "model sees everything" behaviour.
WORKSPACE_RETRIEVAL_TOKEN_BUDGET = 6000

# Chunks pulled per turn when retrieval is active. Matches the Custom
# Models default; ~6 * 500-token chunks ≈ 3k tokens of grounded context.
WORKSPACE_RETRIEVAL_TOP_K = 6


def _estimate_tokens(text: str | None) -> int:
    """Cheap char/4 token estimate — same heuristic the chunker uses."""
    if not text:
        return 0
    return max(0, len(text) // 4)


# ---------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------


async def _set_workspace_file_status(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    status: str,
    error: str | None = None,
    indexed_hash: str | None = None,
) -> None:
    pivot = await db.get(WorkspaceFile, (workspace_id, file_id))
    if pivot is None:
        return
    pivot.indexing_status = status
    pivot.indexing_error = error
    if status == "ready":
        pivot.indexed_at = datetime.now(timezone.utc)
        if indexed_hash is not None:
            pivot.indexed_content_hash = indexed_hash
    await db.commit()


async def index_file_for_workspace(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed (or re-embed) a single pinned workspace file.

    Owns its own DB session so it's safe on a ``BackgroundTasks``
    runner. No-op (status stays ``queued``, no error) when embeddings
    aren't configured — the workspace just keeps full-dumping until an
    admin sets up an embedding provider, then a re-pin indexes it.
    """
    async with SessionLocal() as db:
        try:
            file = await db.get(UserFile, file_id)
            if file is None:
                await _set_workspace_file_status(
                    db,
                    workspace_id=workspace_id,
                    file_id=file_id,
                    status="failed",
                    error="source file no longer exists",
                )
                return

            cfg = await get_embedding_config(db)
            if cfg is None:
                # No embedding provider yet — leave queued so a later
                # re-pin (after setup) picks it up. Not an error.
                return

            # Images and binaries have no machine-extractable text. They're
            # only RAG candidates when a Vision relay is configured to
            # describe them (images) or OCR them (scanned PDFs); otherwise
            # they ride the attachment/vision path and stay ``queued`` so
            # retrieval simply ignores them.
            vision_candidate = not is_text_extractable(file)

            current_hash = await run_in_threadpool(file_content_hash, file)
            pivot = await db.get(WorkspaceFile, (workspace_id, file_id))
            if (
                not force
                and pivot is not None
                and pivot.indexed_content_hash == current_hash
                and pivot.indexing_status == "ready"
            ):
                return

            await _set_workspace_file_status(
                db, workspace_id=workspace_id, file_id=file_id, status="embedding"
            )

            # Resolve the text to embed. Text/PDF flows through the normal
            # extractor; images go straight to the vision describer; a PDF
            # with no embedded text layer falls back to vision OCR.
            text_override: str | None = None
            if vision_candidate:
                text_override = await extract_text_via_vision(db, file)
                if not text_override:
                    # No relay (or it produced nothing) → not indexable.
                    # Leave queued (not failed) so configuring a relay and
                    # re-pinning indexes it cleanly later.
                    await _set_workspace_file_status(
                        db,
                        workspace_id=workspace_id,
                        file_id=file_id,
                        status="queued",
                    )
                    return

            try:
                if text_override is not None:
                    chunks, embeddings = await embed_text_to_chunks(
                        text_override,
                        provider=cfg.provider,
                        model_id=cfg.model_id,
                        dim=cfg.dim,
                    )
                else:
                    try:
                        chunks, embeddings = await embed_file_to_chunks(
                            file,
                            provider=cfg.provider,
                            model_id=cfg.model_id,
                            dim=cfg.dim,
                        )
                    except ValueError:
                        # Text-extractable on paper but yielded nothing —
                        # almost always a scan-only PDF. Try vision OCR
                        # before giving up.
                        ocr_text = await extract_text_via_vision(db, file)
                        if not ocr_text:
                            raise
                        chunks, embeddings = await embed_text_to_chunks(
                            ocr_text,
                            provider=cfg.provider,
                            model_id=cfg.model_id,
                            dim=cfg.dim,
                        )
            except ValueError as exc:
                await _set_workspace_file_status(
                    db,
                    workspace_id=workspace_id,
                    file_id=file_id,
                    status="failed",
                    error=str(exc),
                )
                return

            await delete_existing_chunks(
                db, scope_kind="workspace", scope_id=workspace_id, user_file_id=file_id
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file_id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            await _set_workspace_file_status(
                db,
                workspace_id=workspace_id,
                file_id=file_id,
                status="ready",
                indexed_hash=current_hash,
            )
            logger.info(
                "indexed %d chunks for workspace=%s file=%s",
                len(chunks),
                workspace_id,
                file_id,
            )
        except Exception as exc:  # noqa: BLE001 - last-line catch
            logger.exception("index_file_for_workspace failed")
            try:
                await _set_workspace_file_status(
                    db,
                    workspace_id=workspace_id,
                    file_id=file_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:  # noqa: BLE001
                pass


async def delete_workspace_file_chunks(
    workspace_id: uuid.UUID, file_id: uuid.UUID
) -> None:
    """Drop a file's workspace-scoped chunks (called on unpin). Owns its
    own session so it's safe on a ``BackgroundTasks`` runner."""
    async with SessionLocal() as db:
        await delete_existing_chunks(
            db, scope_kind="workspace", scope_id=workspace_id, user_file_id=file_id
        )


async def index_task_attachment_for_workspace(
    workspace_id: uuid.UUID, file_id: uuid.UUID
) -> None:
    """Embed a card attachment into the workspace RAG pool.

    Mirrors :func:`index_file_for_workspace` but without a ``WorkspaceFile``
    pivot — attachments aren't pinned files, they hang off a card. Chunks
    share the same ``(workspace_id, user_file_id)`` scope so retrieval picks
    them up next to everything else. Best-effort + silent: images with no
    Vision relay (and any failure) simply produce no chunks. Owns its own
    session so it's safe on a ``BackgroundTasks`` runner."""
    async with SessionLocal() as db:
        try:
            file = await db.get(UserFile, file_id)
            if file is None:
                return
            cfg = await get_embedding_config(db)
            if cfg is None:
                return

            text_override: str | None = None
            if not is_text_extractable(file):
                text_override = await extract_text_via_vision(db, file)
                if not text_override:
                    return  # image with no relay → nothing to index

            try:
                if text_override is not None:
                    chunks, embeddings = await embed_text_to_chunks(
                        text_override,
                        provider=cfg.provider,
                        model_id=cfg.model_id,
                        dim=cfg.dim,
                    )
                else:
                    try:
                        chunks, embeddings = await embed_file_to_chunks(
                            file,
                            provider=cfg.provider,
                            model_id=cfg.model_id,
                            dim=cfg.dim,
                        )
                    except ValueError:
                        ocr_text = await extract_text_via_vision(db, file)
                        if not ocr_text:
                            return
                        chunks, embeddings = await embed_text_to_chunks(
                            ocr_text,
                            provider=cfg.provider,
                            model_id=cfg.model_id,
                            dim=cfg.dim,
                        )
            except ValueError:
                return  # unembeddable content — leave it as a plain attachment

            await delete_existing_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file_id,
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file_id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            logger.info(
                "indexed %d chunks for workspace=%s attachment=%s",
                len(chunks),
                workspace_id,
                file_id,
            )
        except Exception:  # noqa: BLE001 - best-effort background indexer
            logger.exception("index_task_attachment_for_workspace failed")


async def reindex_workspace(workspace_id: uuid.UUID) -> None:
    """Re-index every text file pinned to a workspace. Used after the
    admin changes the workspace embedding provider (dims would mismatch)."""
    async with SessionLocal() as db:
        rows = await db.execute(
            select(WorkspaceFile.file_id).where(
                WorkspaceFile.workspace_id == workspace_id
            )
        )
        file_ids = [r[0] for r in rows.all()]
    for fid in file_ids:
        await index_file_for_workspace(workspace_id, fid, force=True)


# ---------------------------------------------------------------------
# Note ingestion (first-class notes — Phase 1b)
# ---------------------------------------------------------------------
# A note is an ordinary Drive Document (``source_kind='document'``) whose
# rendered HTML blob is text-extractable, so it rides the same embed
# pipeline as pinned files. The only difference is bookkeeping: its index
# lifecycle lives on the ``workspace_items`` row (decision O3), not on a
# ``workspace_files`` pivot. Its chunks share the workspace scope
# (``workspace_id`` + ``user_file_id``), so retrieval picks them up next
# to pinned files with zero extra wiring.


async def _set_note_index_status(
    db: AsyncSession,
    *,
    item_id: uuid.UUID,
    status: str,
    error: str | None = None,
    indexed_hash: str | None = None,
) -> None:
    item = await db.get(WorkspaceItem, item_id)
    if item is None:
        return
    item.indexing_status = status
    item.indexing_error = error
    if status == "ready":
        item.indexed_at = datetime.now(timezone.utc)
        if indexed_hash is not None:
            item.indexed_content_hash = indexed_hash
    await db.commit()


async def index_note_for_workspace(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed (or re-embed) a workspace note so chats can retrieve it.

    Enqueued from the document snapshot endpoint when a note's content
    changes. Owns its own session (``BackgroundTasks``-safe). No-ops
    quietly when embeddings aren't configured or the note is still
    empty — a blank note simply stays ``queued`` rather than failing.
    """
    async with SessionLocal() as db:
        try:
            item = await db.get(WorkspaceItem, item_id)
            if item is None or item.kind != "note" or item.ref_id is None:
                return
            file = await db.get(UserFile, item.ref_id)
            if file is None:
                await _set_note_index_status(
                    db,
                    item_id=item_id,
                    status="failed",
                    error="note document no longer exists",
                )
                return

            cfg = await get_embedding_config(db)
            if cfg is None:
                return  # leave queued until an embedding provider exists

            # Empty / never-typed note → nothing to embed. Leave queued
            # (not failed) so the first real edit indexes it cleanly.
            if not (file.content_text or "").strip():
                return

            current_hash = await run_in_threadpool(file_content_hash, file)
            if (
                not force
                and item.indexed_content_hash == current_hash
                and item.indexing_status == "ready"
            ):
                return

            await _set_note_index_status(
                db, item_id=item_id, status="embedding"
            )
            # Index the note's *title* alongside its body, from the clean
            # ``content_text`` (HTML stripped) rather than the raw HTML blob.
            # Embedding the title is what lets a query like "the golden
            # retriever names I listed" match a note titled "Golden retriever
            # name" whose body is just the bare names — without it, in a large
            # (retrieval-mode) workspace that tiny chunk never reaches top-k.
            note_title = (item.title or "").strip()
            note_body = (file.content_text or "").strip()
            embed_text = (
                f"{note_title}\n\n{note_body}" if note_title else note_body
            )
            try:
                chunks, embeddings = await embed_text_to_chunks(
                    embed_text,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except ValueError as exc:
                await _set_note_index_status(
                    db, item_id=item_id, status="failed", error=str(exc)
                )
                return

            await delete_existing_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file.id,
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file.id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            await _set_note_index_status(
                db,
                item_id=item_id,
                status="ready",
                indexed_hash=current_hash,
            )
            logger.info(
                "indexed %d chunks for workspace=%s note=%s",
                len(chunks),
                workspace_id,
                item_id,
            )
        except Exception as exc:  # noqa: BLE001 - last-line catch
            logger.exception("index_note_for_workspace failed")
            try:
                await _set_note_index_status(
                    db,
                    item_id=item_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:  # noqa: BLE001
                pass


async def index_canvas_for_workspace(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed a canvas's flattened shape text into the workspace pool.

    The canvas text lives on a backing Drive file (``text_file_id``),
    pushed by the client via ``POST /api/canvas/{id}/text``. We embed
    that file so the canvas participates in retrieval just like a note.
    Index status is tracked on the navigator item row (kind='canvas').
    """
    async with SessionLocal() as db:
        try:
            item = await db.get(WorkspaceItem, item_id)
            if item is None or item.kind != "canvas" or item.ref_id is None:
                return
            canvas = await db.get(WorkspaceCanvas, item.ref_id)
            if canvas is None or canvas.text_file_id is None:
                return
            file = await db.get(UserFile, canvas.text_file_id)
            if file is None:
                await _set_note_index_status(
                    db,
                    item_id=item_id,
                    status="failed",
                    error="canvas text file no longer exists",
                )
                return

            cfg = await get_embedding_config(db)
            if cfg is None:
                return

            # Empty board → drop any stale chunks, leave queued.
            if not (file.content_text or "").strip():
                await delete_existing_chunks(
                    db,
                    scope_kind="workspace",
                    scope_id=workspace_id,
                    user_file_id=file.id,
                )
                await _set_note_index_status(
                    db, item_id=item_id, status="queued"
                )
                return

            current_hash = await run_in_threadpool(file_content_hash, file)
            if (
                not force
                and item.indexed_content_hash == current_hash
                and item.indexing_status == "ready"
            ):
                return

            await _set_note_index_status(
                db, item_id=item_id, status="embedding"
            )
            try:
                chunks, embeddings = await embed_file_to_chunks(
                    file,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except ValueError as exc:
                await _set_note_index_status(
                    db, item_id=item_id, status="failed", error=str(exc)
                )
                return

            await delete_existing_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file.id,
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=file.id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            await _set_note_index_status(
                db,
                item_id=item_id,
                status="ready",
                indexed_hash=current_hash,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("index_canvas_for_workspace failed")
            try:
                await _set_note_index_status(
                    db,
                    item_id=item_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:  # noqa: BLE001
                pass


async def index_sheet_for_workspace(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed a sheet's flattened cell text into the workspace pool.

    The client pushes flattened cell text on save (``content_text``); we
    mirror it onto a backing Drive file (``Spreadsheet.text_file_id``,
    created on demand) and embed that, so the sheet participates in
    retrieval like a note/canvas/board. Index status is tracked on the
    navigator item row (kind='sheet'). Owns its own session
    (``BackgroundTasks``-safe); no-ops when embeddings aren't configured.
    """
    async with SessionLocal() as db:
        try:
            item = await db.get(WorkspaceItem, item_id)
            if item is None or item.kind != "sheet" or item.ref_id is None:
                return
            ws = await db.get(Workspace, workspace_id)
            if ws is None:
                return
            sheet = await db.get(Spreadsheet, item.ref_id)
            if sheet is None:
                return
            cfg = await get_embedding_config(db)
            if cfg is None:
                return

            text = (sheet.content_text or "").strip()
            if not text:
                # Empty sheet → drop any stale chunks + blank the backing file
                # so full-dump stops inlining old cells; park at queued.
                if sheet.text_file_id is not None:
                    await delete_existing_chunks(
                        db,
                        scope_kind="workspace",
                        scope_id=workspace_id,
                        user_file_id=sheet.text_file_id,
                    )
                    uf = await db.get(UserFile, sheet.text_file_id)
                    if uf is not None and uf.trashed_at is None:
                        uf.content_text = None
                        try:
                            abs_path = absolute_path(uf.storage_path)
                            abs_path.parent.mkdir(parents=True, exist_ok=True)
                            with open(abs_path, "w", encoding="utf-8") as fh:
                                fh.write("")
                            uf.size_bytes = 0
                        except OSError:
                            pass
                await _set_note_index_status(
                    db, item_id=item_id, status="queued"
                )
                return

            current_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if (
                not force
                and item.indexed_content_hash == current_hash
                and item.indexing_status == "ready"
            ):
                return

            await _set_note_index_status(
                db, item_id=item_id, status="embedding"
            )
            uf = await _ensure_sheet_backing_file(
                db, ws=ws, sheet=sheet, text=text
            )
            if uf is None:
                await _set_note_index_status(
                    db,
                    item_id=item_id,
                    status="failed",
                    error="workspace owner missing",
                )
                return

            try:
                chunks, embeddings = await embed_text_to_chunks(
                    text,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except ValueError as exc:
                await _set_note_index_status(
                    db, item_id=item_id, status="failed", error=str(exc)
                )
                return

            await delete_existing_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=uf.id,
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=uf.id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            await _set_note_index_status(
                db, item_id=item_id, status="ready", indexed_hash=current_hash
            )
        except Exception:  # noqa: BLE001 - last-line catch
            logger.exception("index_sheet_for_workspace failed")
            try:
                await _set_note_index_status(
                    db, item_id=item_id, status="failed", error="indexing error"
                )
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------
# Chat ingestion (opt-in chat-as-context — 0090)
# ---------------------------------------------------------------------
# Chats are scratch space by default and carry no item row, so unlike
# notes/canvases there's no backing file until the user flips a chat's
# "Use as workspace context" toggle ON. At that point we flatten the
# transcript into a Drive file in the workspace's ``Chats/`` folder and
# embed it into the shared workspace pool just like a note. Turning the
# toggle OFF drops the chunks and trashes the backing file. The index
# lifecycle is tracked inline on the ``conversations`` row.


def _flatten_conversation(conv: Conversation, messages: list[Message]) -> str:
    """Render a conversation as a plain-text transcript for embedding.

    System messages are dropped (workspace instructions, not content) and
    each turn is labelled by role so a retrieved chunk reads sensibly. No
    per-message cap — the chunker handles length; we want the full content
    available to retrieval.
    """
    title = conv.title or "Chat"
    lines: list[str] = []
    for m in messages:
        content = (m.content or "").strip()
        if not content or m.role == "system":
            continue
        lines.append(f"{(m.role or 'user').upper()}: {content}")
    if not lines:
        return ""
    return f"# Chat: {title}\n\n" + "\n\n".join(lines)


async def _ensure_chat_backing_file(
    db: AsyncSession,
    *,
    ws: Workspace,
    conv: Conversation,
    transcript: str,
) -> UserFile | None:
    """Create or update the Drive file backing a context-enabled chat.

    Returns the ``UserFile`` (with its blob + ``content_text`` refreshed),
    or ``None`` if the workspace owner can't be resolved. The file id is
    stashed on ``conv.context_file_id`` so subsequent refreshes update in
    place rather than spawning a new file per turn.
    """
    owner = await db.get(User, ws.user_id)
    if owner is None:
        return None
    now = datetime.now(timezone.utc)
    title = conv.title or "Chat"

    # Update the existing backing file in place when we still have one.
    if conv.context_file_id is not None:
        uf = await db.get(UserFile, conv.context_file_id)
        if uf is not None and uf.trashed_at is None:
            abs_path = absolute_path(uf.storage_path)
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as fh:
                fh.write(transcript)
            uf.filename = f"{title}.md"
            uf.size_bytes = len(transcript.encode("utf-8"))
            uf.content_text = transcript
            uf.updated_at = now
            await db.flush()
            return uf

    # Otherwise lay down a fresh file in the workspace's Chats/ folder.
    file_id = uuid.uuid4()
    rel_path = storage_path_for(owner.id, file_id, ".md")
    ensure_bucket(owner.id)
    abs_path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write(transcript)

    folder_id: uuid.UUID | None = None
    if ws.root_folder_id is not None:
        sub = await get_or_create_subfolder(
            db, user_id=owner.id, parent_id=ws.root_folder_id, name="Chats"
        )
        folder_id = sub.id

    uf = UserFile(
        id=file_id,
        user_id=owner.id,
        folder_id=folder_id,
        filename=f"{title}.md",
        original_filename=f"{title}.md",
        mime_type="text/markdown",
        size_bytes=len(transcript.encode("utf-8")),
        storage_path=rel_path,
        source_kind=GeneratedKind.CHAT_TRANSCRIPT.value,
        content_text=transcript,
    )
    db.add(uf)
    await db.flush()
    conv.context_file_id = uf.id
    return uf


async def index_chat_for_workspace(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed (or re-embed) a context-enabled chat's transcript.

    Enqueued when the user turns a chat's context toggle ON and again on
    each reply finalize while it's on. Owns its own session
    (``BackgroundTasks``-safe). No-ops when embeddings aren't configured;
    self-heals to cleanup if the toggle was flipped off in the meantime.
    """
    async with SessionLocal() as db:
        try:
            conv = await db.get(Conversation, conversation_id)
            if conv is None or conv.workspace_id != workspace_id:
                return
            if not conv.context_enabled:
                await _remove_chat_context_inner(db, conv, workspace_id)
                return

            ws = await db.get(Workspace, workspace_id)
            if ws is None:
                return

            cfg = await get_embedding_config(db)
            if cfg is None:
                return  # leave queued until an embedding provider exists

            messages = list(
                (
                    await db.execute(
                        select(Message)
                        .where(Message.conversation_id == conv.id)
                        .order_by(Message.created_at.asc())
                    )
                )
                .scalars()
                .all()
            )
            transcript = _flatten_conversation(conv, messages)
            if not transcript.strip():
                # Nothing to embed yet (empty / system-only chat).
                conv.context_index_status = "queued"
                await db.commit()
                return

            current_hash = hashlib.sha256(
                transcript.encode("utf-8")
            ).hexdigest()
            if (
                not force
                and conv.context_indexed_hash == current_hash
                and conv.context_index_status == "ready"
            ):
                return

            conv.context_index_status = "embedding"
            await db.commit()

            uf = await _ensure_chat_backing_file(
                db, ws=ws, conv=conv, transcript=transcript
            )
            if uf is None:
                conv.context_index_status = "failed"
                await db.commit()
                return

            try:
                chunks, embeddings = await embed_text_to_chunks(
                    transcript,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except ValueError as exc:
                conv.context_index_status = "failed"
                await db.commit()
                logger.info("chat index produced no chunks: %s", exc)
                return

            await delete_existing_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=uf.id,
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=uf.id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            conv.context_index_status = "ready"
            conv.context_indexed_hash = current_hash
            await db.commit()
            logger.info(
                "indexed %d chunks for workspace=%s chat=%s",
                len(chunks),
                workspace_id,
                conversation_id,
            )
        except Exception:  # noqa: BLE001 - last-line catch
            logger.exception("index_chat_for_workspace failed")
            try:
                conv = await db.get(Conversation, conversation_id)
                if conv is not None:
                    conv.context_index_status = "failed"
                    await db.commit()
            except Exception:  # noqa: BLE001
                pass


async def _remove_chat_context_inner(
    db: AsyncSession, conv: Conversation, workspace_id: uuid.UUID
) -> None:
    """Drop a chat's chunks + trash its backing file (toggle turned off)."""
    if conv.context_file_id is not None:
        await delete_existing_chunks(
            db,
            scope_kind="workspace",
            scope_id=workspace_id,
            user_file_id=conv.context_file_id,
        )
        uf = await db.get(UserFile, conv.context_file_id)
        if uf is not None and uf.trashed_at is None:
            uf.trashed_at = datetime.now(timezone.utc)
    conv.context_file_id = None
    conv.context_index_status = None
    conv.context_indexed_hash = None
    await db.commit()


async def remove_chat_context(
    workspace_id: uuid.UUID, conversation_id: uuid.UUID
) -> None:
    """Tear down a chat's workspace-context index. Owns its own session."""
    async with SessionLocal() as db:
        conv = await db.get(Conversation, conversation_id)
        if conv is None:
            return
        await _remove_chat_context_inner(db, conv, workspace_id)


# ---------------------------------------------------------------------
# Board ingestion (boards feed RAG like notes — Phase 0+)
# ---------------------------------------------------------------------
_BOARD_STATUS_LABEL = {"todo": "To Do", "doing": "In Progress", "done": "Done"}


def _flatten_board(
    item: WorkspaceItem,
    tasks: list[WorkspaceTask],
    assignee_names: dict[str, str] | None = None,
    comments_by_task: dict[str, list[str]] | None = None,
) -> str:
    """Render a board's tasks as natural-language text for embedding."""
    assignee_names = assignee_names or {}
    comments_by_task = comments_by_task or {}
    rows = [t for t in tasks if (t.title or "").strip()]
    if not rows:
        return ""
    title = item.title or "Board"
    cfg = item.config if isinstance(item.config, dict) else {}
    # Resolve label ids → names from the board's registry (config.labels).
    label_names: dict[str, str] = {}
    for lab in cfg.get("labels") or []:
        if isinstance(lab, dict) and lab.get("id"):
            label_names[str(lab["id"])] = str(lab.get("name") or "")
    # Resolve column ids → names (custom columns); fall back to defaults.
    col_names: dict[str, str] = dict(_BOARD_STATUS_LABEL)
    for col in cfg.get("columns") or []:
        if isinstance(col, dict) and col.get("id"):
            col_names[str(col["id"])] = str(col.get("name") or col["id"])
    lines = [f"# Board: {title}", ""]
    for t in rows:
        bits = [
            f"status {col_names.get(t.status, t.status)}",
            f"{t.priority} priority",
        ]
        if t.due_at is not None:
            bits.append(f"due {t.due_at.date().isoformat()}")
        names = [
            label_names.get(lid, "")
            for lid in (t.labels or [])
            if label_names.get(lid)
        ]
        if names:
            bits.append("labels " + ", ".join(names))
        if t.assignee_user_id is not None:
            who = assignee_names.get(str(t.assignee_user_id))
            if who:
                bits.append(f"assigned to {who}")
        line = f'- Task "{t.title.strip()}": ' + ", ".join(bits) + "."
        comments = comments_by_task.get(str(t.id)) or []
        if comments:
            line += " Comments: " + " | ".join(comments)
        desc = (t.description or "").strip()
        if desc:
            line += f" Description: {desc[:1000]}"
        links = t.links or []
        if links:
            names = [
                str(lk.get("title")).strip()
                for lk in links
                if isinstance(lk, dict) and str(lk.get("title") or "").strip()
            ]
            if names:
                line += " Linked: " + ", ".join(names)
        atts = t.attachments or []
        if atts:
            fnames = [
                str(a.get("filename")).strip()
                for a in atts
                if isinstance(a, dict) and str(a.get("filename") or "").strip()
            ]
            if fnames:
                line += " Attachments: " + ", ".join(fnames)
        subs = t.subtasks or []
        if subs:
            done_n = sum(1 for s in subs if s.get("done"))
            checklist = "; ".join(
                ("[x] " if s.get("done") else "[ ] ") + str(s.get("text", ""))
                for s in subs
            )
            line += f" Subtasks ({done_n}/{len(subs)}): {checklist}"
        lines.append(line)
    return "\n".join(lines)


async def _ensure_board_backing_file(
    db: AsyncSession, *, ws: Workspace, item: WorkspaceItem, text: str
) -> UserFile | None:
    """Create or update the Drive file backing a board's RAG text. The file
    id is stored on ``item.ref_id`` so re-indexes update it in place."""
    owner = await db.get(User, ws.user_id)
    if owner is None:
        return None
    now = datetime.now(timezone.utc)
    title = item.title or "Board"

    if item.ref_id is not None:
        uf = await db.get(UserFile, item.ref_id)
        if uf is not None and uf.trashed_at is None:
            abs_path = absolute_path(uf.storage_path)
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as fh:
                fh.write(text)
            uf.filename = f"{title}.md"
            uf.size_bytes = len(text.encode("utf-8"))
            uf.content_text = text
            uf.updated_at = now
            await db.flush()
            return uf

    file_id = uuid.uuid4()
    rel_path = storage_path_for(owner.id, file_id, ".md")
    ensure_bucket(owner.id)
    abs_path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write(text)

    folder_id: uuid.UUID | None = None
    if ws.root_folder_id is not None:
        sub = await get_or_create_subfolder(
            db, user_id=owner.id, parent_id=ws.root_folder_id, name="Boards"
        )
        folder_id = sub.id

    uf = UserFile(
        id=file_id,
        user_id=owner.id,
        folder_id=folder_id,
        filename=f"{title}.md",
        original_filename=f"{title}.md",
        mime_type="text/markdown",
        size_bytes=len(text.encode("utf-8")),
        storage_path=rel_path,
        source_kind=GeneratedKind.BOARD_TEXT.value,
        content_text=text,
    )
    db.add(uf)
    await db.flush()
    item.ref_id = uf.id
    return uf


async def _ensure_sheet_backing_file(
    db: AsyncSession, *, ws: Workspace, sheet: Spreadsheet, text: str
) -> UserFile | None:
    """Create or update the Drive file backing a sheet's RAG text. The file
    id is stored on ``Spreadsheet.text_file_id`` so re-indexes update it in
    place — the spreadsheet analogue of :func:`_ensure_board_backing_file`."""
    owner = await db.get(User, ws.user_id)
    if owner is None:
        return None
    now = datetime.now(timezone.utc)
    title = sheet.title or "Sheet"

    if sheet.text_file_id is not None:
        uf = await db.get(UserFile, sheet.text_file_id)
        if uf is not None and uf.trashed_at is None:
            abs_path = absolute_path(uf.storage_path)
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as fh:
                fh.write(text)
            uf.filename = f"{title}.md"
            uf.size_bytes = len(text.encode("utf-8"))
            uf.content_text = text
            uf.updated_at = now
            await db.flush()
            return uf

    file_id = uuid.uuid4()
    rel_path = storage_path_for(owner.id, file_id, ".md")
    ensure_bucket(owner.id)
    abs_path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write(text)

    folder_id: uuid.UUID | None = None
    if ws.root_folder_id is not None:
        sub = await get_or_create_subfolder(
            db, user_id=owner.id, parent_id=ws.root_folder_id, name="Sheets"
        )
        folder_id = sub.id

    uf = UserFile(
        id=file_id,
        user_id=owner.id,
        folder_id=folder_id,
        filename=f"{title}.md",
        original_filename=f"{title}.md",
        mime_type="text/markdown",
        size_bytes=len(text.encode("utf-8")),
        storage_path=rel_path,
        source_kind=GeneratedKind.SHEET_TEXT.value,
        content_text=text,
    )
    db.add(uf)
    await db.flush()
    sheet.text_file_id = uf.id
    return uf


async def index_board_for_workspace(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed (or re-embed) a board's task list so chats can retrieve it.

    Enqueued whenever the board's tasks change. Owns its own session
    (``BackgroundTasks``-safe). No-ops when embeddings aren't configured;
    an empty board drops its chunks and parks at ``queued``."""
    async with SessionLocal() as db:
        try:
            item = await db.get(WorkspaceItem, item_id)
            if item is None or item.kind != "board":
                return
            ws = await db.get(Workspace, workspace_id)
            if ws is None:
                return
            cfg = await get_embedding_config(db)
            if cfg is None:
                return

            tasks = list(
                (
                    await db.execute(
                        select(WorkspaceTask)
                        .where(WorkspaceTask.board_item_id == item.id)
                        .order_by(
                            WorkspaceTask.status.asc(),
                            WorkspaceTask.position.asc(),
                        )
                    )
                )
                .scalars()
                .all()
            )
            # Resolve assignee user ids → usernames for the RAG text.
            assignee_ids = {
                t.assignee_user_id for t in tasks if t.assignee_user_id
            }
            assignee_names: dict[str, str] = {}
            if assignee_ids:
                users = (
                    await db.execute(
                        select(User).where(User.id.in_(assignee_ids))
                    )
                ).scalars().all()
                assignee_names = {str(u.id): u.username for u in users}
            # Load user comments (not activity) so discussion is searchable.
            comments_by_task: dict[str, list[str]] = {}
            task_ids = [t.id for t in tasks]
            if task_ids:
                crows = (
                    await db.execute(
                        select(WorkspaceTaskComment)
                        .where(
                            WorkspaceTaskComment.task_id.in_(task_ids),
                            WorkspaceTaskComment.kind == "comment",
                        )
                        .order_by(WorkspaceTaskComment.created_at.asc())
                    )
                ).scalars().all()
                for c in crows:
                    comments_by_task.setdefault(str(c.task_id), []).append(
                        c.text
                    )
            text = _flatten_board(
                item, tasks, assignee_names, comments_by_task
            )
            if not text.strip():
                # Empty board: drop its chunks AND blank the backing file so
                # full-dump injection doesn't keep inlining stale tasks.
                if item.ref_id is not None:
                    await delete_existing_chunks(
                        db,
                        scope_kind="workspace",
                        scope_id=workspace_id,
                        user_file_id=item.ref_id,
                    )
                    uf = await db.get(UserFile, item.ref_id)
                    if uf is not None and uf.trashed_at is None:
                        uf.content_text = None
                        try:
                            abs_path = absolute_path(uf.storage_path)
                            abs_path.parent.mkdir(parents=True, exist_ok=True)
                            with open(abs_path, "w", encoding="utf-8") as fh:
                                fh.write("")
                            uf.size_bytes = 0
                        except OSError:
                            pass
                await _set_note_index_status(
                    db, item_id=item_id, status="queued"
                )
                return

            current_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if (
                not force
                and item.indexed_content_hash == current_hash
                and item.indexing_status == "ready"
            ):
                return

            await _set_note_index_status(
                db, item_id=item_id, status="embedding"
            )
            uf = await _ensure_board_backing_file(
                db, ws=ws, item=item, text=text
            )
            if uf is None:
                await _set_note_index_status(
                    db,
                    item_id=item_id,
                    status="failed",
                    error="workspace owner missing",
                )
                return

            try:
                chunks, embeddings = await embed_text_to_chunks(
                    text,
                    provider=cfg.provider,
                    model_id=cfg.model_id,
                    dim=cfg.dim,
                )
            except ValueError as exc:
                await _set_note_index_status(
                    db, item_id=item_id, status="failed", error=str(exc)
                )
                return

            await delete_existing_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=uf.id,
            )
            await insert_chunks(
                db,
                scope_kind="workspace",
                scope_id=workspace_id,
                user_file_id=uf.id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=cfg.model_id,
                embedding_dim=cfg.dim,
            )
            await _set_note_index_status(
                db, item_id=item_id, status="ready", indexed_hash=current_hash
            )
        except Exception:  # noqa: BLE001 - last-line catch
            logger.exception("index_board_for_workspace failed")
            try:
                await _set_note_index_status(
                    db, item_id=item_id, status="failed", error="indexing error"
                )
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------
# Injection (per-send)
# ---------------------------------------------------------------------


@dataclass
class WorkspaceInjection:
    """What the send path should do with a workspace's pinned files.

    ``system_block`` — retrieved "Workspace knowledge" text to splice into
    the system prompt (``None`` in full-dump mode or when nothing
    matched). ``attach_file_ids`` — files to fold into the triggering
    turn's attachments (full-dump mode: everything; retrieval mode:
    images + not-yet-indexed text as a fallback). ``retrieval_active``
    is surfaced for logging / SSE only.
    """

    system_block: str | None = None
    attach_file_ids: list[uuid.UUID] = field(default_factory=list)
    retrieval_active: bool = False


async def _indexed_token_total(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    total = await db.scalar(
        select(func.coalesce(func.sum(KnowledgeChunk.tokens), 0)).where(
            KnowledgeChunk.workspace_id == workspace_id
        )
    )
    return int(total or 0)


# Char ceiling for the full-dump "Workspace notes" block. ~6k tokens —
# the same budget that flips a workspace into retrieval mode, so a
# workspace whose notes exceed this is already being retrieved (chunked)
# rather than dumped whole.
_NOTES_FULLDUMP_CHAR_CAP = WORKSPACE_RETRIEVAL_TOKEN_BUDGET * 4


async def context_disabled_file_ids(
    db: AsyncSession, workspace_id: uuid.UUID
) -> set[uuid.UUID]:
    """Backing file ids of items the user has flipped OFF for workspace
    context ("Use as workspace context" toggle).

    Covers disabled notes + boards (``ref_id`` is the backing UserFile),
    disabled canvases (mapped to their backing ``text_file_id``), and
    disabled pinned files. The injection builder unions this into its
    excluded set so a disabled item's embeddings are simply never
    retrieved — the chunks stay put, so re-enabling is instant.
    """
    out: set[uuid.UUID] = set()

    # An item is excluded when its own context toggle is OFF, or when it's a
    # page inside a Notebook (container) whose context toggle is OFF — the
    # container acts as a master switch over its pages.
    Parent = aliased(WorkspaceItem)

    def _disabled(item):
        return or_(
            item.context_enabled.is_(False),
            and_(
                Parent.kind == "container",
                Parent.context_enabled.is_(False),
            ),
        )

    # Notes and boards both back their RAG text on ``ref_id``.
    note_ids = await db.execute(
        select(WorkspaceItem.ref_id)
        .outerjoin(Parent, Parent.id == WorkspaceItem.parent_id)
        .where(
            WorkspaceItem.workspace_id == workspace_id,
            WorkspaceItem.kind.in_(("note", "board")),
            WorkspaceItem.ref_id.is_not(None),
            _disabled(WorkspaceItem),
        )
    )
    out.update(r for (r,) in note_ids if r is not None)

    canvas_ids = await db.execute(
        select(WorkspaceCanvas.text_file_id)
        .join(WorkspaceItem, WorkspaceItem.ref_id == WorkspaceCanvas.id)
        .outerjoin(Parent, Parent.id == WorkspaceItem.parent_id)
        .where(
            WorkspaceItem.workspace_id == workspace_id,
            WorkspaceItem.kind == "canvas",
            WorkspaceCanvas.text_file_id.is_not(None),
            _disabled(WorkspaceItem),
        )
    )
    out.update(r for (r,) in canvas_ids if r is not None)

    sheet_ids = await db.execute(
        select(Spreadsheet.text_file_id)
        .join(WorkspaceItem, WorkspaceItem.ref_id == Spreadsheet.id)
        .outerjoin(Parent, Parent.id == WorkspaceItem.parent_id)
        .where(
            WorkspaceItem.workspace_id == workspace_id,
            WorkspaceItem.kind == "sheet",
            Spreadsheet.text_file_id.is_not(None),
            _disabled(WorkspaceItem),
        )
    )
    out.update(r for (r,) in sheet_ids if r is not None)

    file_ids = await db.execute(
        select(WorkspaceFile.file_id).where(
            WorkspaceFile.workspace_id == workspace_id,
            WorkspaceFile.context_enabled.is_(False),
        )
    )
    out.update(r for (r,) in file_ids if r is not None)

    return out


async def _workspace_notes(
    db: AsyncSession, workspace_id: uuid.UUID, excluded: set[uuid.UUID]
) -> list[tuple[WorkspaceItem, UserFile]]:
    """Live note items in the workspace paired with their backing doc,
    minus anything this chat has excluded (by note file id)."""
    rows = (
        await db.execute(
            select(WorkspaceItem, UserFile)
            .join(UserFile, UserFile.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == workspace_id,
                WorkspaceItem.kind == "note",
                UserFile.trashed_at.is_(None),
            )
            .order_by(WorkspaceItem.position.asc())
        )
    ).all()
    return [(it, uf) for it, uf in rows if uf.id not in excluded]


async def _workspace_canvases(
    db: AsyncSession, workspace_id: uuid.UUID, excluded: set[uuid.UUID]
) -> list[tuple[WorkspaceItem, WorkspaceCanvas]]:
    """Live canvas items paired with their canvas row, minus anything
    this chat has excluded (by the canvas's backing text-file id)."""
    rows = (
        await db.execute(
            select(WorkspaceItem, WorkspaceCanvas)
            .join(WorkspaceCanvas, WorkspaceCanvas.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == workspace_id,
                WorkspaceItem.kind == "canvas",
            )
            .order_by(WorkspaceItem.position.asc())
        )
    ).all()
    return [
        (it, c)
        for it, c in rows
        if c.text_file_id is None or c.text_file_id not in excluded
    ]


async def _workspace_boards(
    db: AsyncSession, workspace_id: uuid.UUID, excluded: set[uuid.UUID]
) -> list[tuple[WorkspaceItem, UserFile]]:
    """Live board items paired with their backing text file (the flattened
    task list), minus anything excluded by that file id."""
    rows = (
        await db.execute(
            select(WorkspaceItem, UserFile)
            .join(UserFile, UserFile.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == workspace_id,
                WorkspaceItem.kind == "board",
                UserFile.trashed_at.is_(None),
            )
            .order_by(WorkspaceItem.position.asc())
        )
    ).all()
    return [(it, uf) for it, uf in rows if uf.id not in excluded]


async def _workspace_sheets(
    db: AsyncSession, workspace_id: uuid.UUID, excluded: set[uuid.UUID]
) -> list[tuple[WorkspaceItem, Spreadsheet]]:
    """Live sheet items paired with their backing spreadsheet row, minus
    anything excluded by the sheet's backing ``text_file_id``."""
    rows = (
        await db.execute(
            select(WorkspaceItem, Spreadsheet)
            .join(Spreadsheet, Spreadsheet.id == WorkspaceItem.ref_id)
            .where(
                WorkspaceItem.workspace_id == workspace_id,
                WorkspaceItem.kind == "sheet",
            )
            .order_by(WorkspaceItem.position.asc())
        )
    ).all()
    return [
        (it, s)
        for it, s in rows
        if s.text_file_id is None or s.text_file_id not in excluded
    ]


def _format_context_block(
    notes: list[tuple[WorkspaceItem, UserFile]],
    canvases: list[tuple[WorkspaceItem, "WorkspaceCanvas"]],
    boards: list[tuple[WorkspaceItem, UserFile]] | None = None,
    sheets: list[tuple[WorkspaceItem, "Spreadsheet"]] | None = None,
) -> str | None:
    """Full text of the workspace's notes + canvases + boards + sheets for
    full-dump mode. Capped so a runaway set can't blow the context window
    (retrieval takes over past the cap). ``None`` when there's nothing."""
    sections: list[tuple[str, str]] = []
    for it, uf in notes:
        text = (uf.content_text or "").strip()
        if text:
            sections.append((it.title, text))
    for it, c in canvases:
        text = (c.content_text or "").strip()
        if text:
            sections.append((f"{it.title} (canvas)", text))
    for it, uf in boards or []:
        text = (uf.content_text or "").strip()
        if text:
            sections.append((f"{it.title} (board)", text))
    for it, s in sheets or []:
        text = (s.content_text or "").strip()
        if text:
            sections.append((f"{it.title} (sheet)", text))
    if not sections:
        return None

    header = (
        "The user's notes, canvases, boards, and sheets in this workspace. "
        "Treat them as authoritative context for this conversation:"
    )
    parts: list[str] = []
    used = 0
    for title, text in sections:
        seg = f"\n\n## {title}\n{text}"
        if used + len(seg) > _NOTES_FULLDUMP_CHAR_CAP:
            seg = seg[: max(0, _NOTES_FULLDUMP_CHAR_CAP - used)]
        parts.append(seg)
        used += len(seg)
        if used >= _NOTES_FULLDUMP_CHAR_CAP:
            break
    return header + "".join(parts)


_MAP_KIND_LABEL = {
    "folder": "Folder",
    "container": "Notebook",
    "note": "Note",
    "sheet": "Sheet",
    "canvas": "Canvas",
    "board": "Board",
    "chat": "Chat",
}
# Soft cap so a giant workspace can't blow the system prompt. Workspaces are
# "dozens of items" in practice; this is a backstop.
_MAP_MAX_LINES = 200


async def build_workspace_map(
    db: AsyncSession, workspace_id: uuid.UUID
) -> str | None:
    """A compact, deterministic table-of-contents of the workspace.

    Lists every item and its place in the tree (notebooks show their pages,
    folders their contents) so a chat always knows *what exists and where to
    look* — then it retrieves / the user @-mentions the actual content. This
    is the "map" layer of workspace memory: no LLM, never stale, regenerated
    from the live tree on every turn.
    """
    items = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == workspace_id,
                    WorkspaceItem.archived_at.is_(None),
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars()
    )
    if not items:
        return None

    by_parent: dict[uuid.UUID | None, list[WorkspaceItem]] = {}
    for it in items:
        by_parent.setdefault(it.parent_id, []).append(it)

    lines: list[str] = []
    truncated = False

    def render(parent_id: uuid.UUID | None, depth: int) -> None:
        nonlocal truncated
        for it in by_parent.get(parent_id, []):
            if len(lines) >= _MAP_MAX_LINES:
                truncated = True
                return
            label = _MAP_KIND_LABEL.get(it.kind, it.kind)
            title = (it.title or "Untitled").strip() or "Untitled"
            lines.append(f'{"  " * depth}- {label}: "{title}"')
            if it.kind in ("folder", "container"):
                render(it.id, depth + 1)

    render(None, 0)
    if not lines:
        return None
    if truncated:
        lines.append(f"  - …and more (showing first {_MAP_MAX_LINES})")

    return (
        "## Workspace contents\n"
        "A map of everything in this workspace. Use it to decide what to look "
        "up — the user can @-mention an item or ask you to use one. This is a "
        "catalog of what exists and where, not the content itself.\n\n"
        + "\n".join(lines)
    )


def _with_map(map_md: str | None, block: str | None) -> str | None:
    """Prepend the workspace map to a context block (either may be None)."""
    parts = [p for p in (map_md, block) if p]
    return "\n\n".join(parts) if parts else None


async def build_workspace_injection(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    query: str,
    excluded_file_ids: set[uuid.UUID] | None = None,
) -> WorkspaceInjection:
    """Decide full-dump vs. retrieval for this turn and return the plan.

    Candidates are the workspace's pinned files **and** its first-class
    notes. Hybrid rule: retrieval kicks in only when embeddings are
    configured AND the workspace's indexed text exceeds
    :data:`WORKSPACE_RETRIEVAL_TOKEN_BUDGET`. Otherwise we full-dump —
    pinned files ride the attachment path and notes are spliced in as a
    "Workspace notes" system block.

    ``excluded_file_ids`` — files / notes the current chat has opted out
    of (per-chat toggle); dropped from attachments, the notes block, and
    the retrieved chunks so this conversation never sees them.

    On top of the per-chat exclusions we always drop items whose
    workspace-level "Use as workspace context" toggle is OFF.
    """
    # The structural map ("what exists and where") is always injected, in
    # every mode — it's deterministic and cheap, and it's what lets the model
    # route to the right item even when retrieval would miss a tiny chunk.
    map_md = await build_workspace_map(db, workspace_id)

    excluded = set(excluded_file_ids or set())
    excluded |= await context_disabled_file_ids(db, workspace_id)
    # In "off" memory mode the workspace memory is dormant — never inject it
    # (it's a pinned file, so it would otherwise ride the pinned-file path).
    ws_row = await db.get(Workspace, workspace_id)
    if ws_row is not None and ws_row.memory_mode == "off":
        mem_doc = await get_workspace_memory_doc(db, workspace_id)
        if mem_doc is not None:
            excluded.add(mem_doc.id)
    file_rows = (
        await db.execute(
            select(WorkspaceFile, UserFile)
            .join(UserFile, UserFile.id == WorkspaceFile.file_id)
            .where(WorkspaceFile.workspace_id == workspace_id)
            .order_by(WorkspaceFile.pinned_at.asc())
        )
    ).all()
    file_rows = [(wsf, uf) for wsf, uf in file_rows if uf.id not in excluded]
    note_rows = await _workspace_notes(db, workspace_id, excluded)
    canvas_rows = await _workspace_canvases(db, workspace_id, excluded)
    board_rows = await _workspace_boards(db, workspace_id, excluded)
    sheet_rows = await _workspace_sheets(db, workspace_id, excluded)
    if (
        not file_rows
        and not note_rows
        and not canvas_rows
        and not board_rows
        and not sheet_rows
    ):
        # No retrievable content, but the map still tells the chat what's here.
        return WorkspaceInjection(system_block=map_md)

    cfg = await get_embedding_config(db)
    indexed_tokens = (
        await _indexed_token_total(db, workspace_id) if cfg is not None else 0
    )
    retrieval_active = (
        cfg is not None and indexed_tokens > WORKSPACE_RETRIEVAL_TOKEN_BUDGET
    )

    # The workspace's own authored items (notes/canvases/boards/sheets) are
    # small, structured, and authoritative — the user expects the chat to
    # always know them. We inject them in full in BOTH modes (capped): in
    # retrieval mode a big pinned file (e.g. a 600k-token PDF) would otherwise
    # dominate top-k and starve a two-task board or a small sheet out of the
    # context entirely. Retrieval then adds the large pinned files on top.
    struct_block = _format_context_block(
        note_rows, canvas_rows, board_rows, sheet_rows
    )

    if not retrieval_active:
        # Full-dump: pinned files ride the attachment path; the authored
        # items are injected as text (no attachment form).
        return WorkspaceInjection(
            system_block=_with_map(map_md, struct_block),
            attach_file_ids=[uf.id for _, uf in file_rows],
            retrieval_active=False,
        )

    # Retrieval mode. The retrieved block already spans the whole
    # workspace pool — pinned files *and* notes share the same
    # ``(workspace_id, user_file_id)`` chunk scope. Ready text files are
    # represented by that block; everything else (images, binaries, text
    # still indexing or failed) still rides the attachment path so
    # nothing is silently dropped during the indexing window.
    attach_ids = [
        uf.id
        for wsf, uf in file_rows
        if not (is_text_extractable(uf) and wsf.indexing_status == "ready")
    ]
    chunks = await retrieve_workspace_context(
        db,
        workspace_id=workspace_id,
        query=query,
        # Pull a few extra so post-filtering excluded files still leaves
        # a useful slate.
        top_k=WORKSPACE_RETRIEVAL_TOP_K + len(excluded),
    )
    if excluded:
        chunks = [c for c in chunks if c.user_file_id not in excluded]
    chunks = chunks[:WORKSPACE_RETRIEVAL_TOP_K]
    retrieved_block = format_retrieved_block(chunks) if chunks else None
    # Authored items (always in full) first, then the retrieved pinned-file
    # context. Either may be empty.
    combined = "\n\n".join(p for p in (struct_block, retrieved_block) if p)
    return WorkspaceInjection(
        system_block=_with_map(map_md, combined or None),
        attach_file_ids=attach_ids,
        retrieval_active=True,
    )


# ---------------------------------------------------------------------
# Budget stats (workspace detail page)
# ---------------------------------------------------------------------


@dataclass
class WorkspaceContextStats:
    instruction_tokens: int
    pinned_file_tokens: int
    per_turn_tokens: int
    retrieval_active: bool
    indexing_count: int
    # True when the workspace has an embedding provider configured so
    # retrieval can run at all. False → files are always in full-dump mode;
    # surfaced in the detail payload so the UI can show an onboarding nudge.
    embeddings_configured: bool = False


async def workspace_context_stats(
    db: AsyncSession, *, workspace_id: uuid.UUID, system_prompt: str | None
) -> WorkspaceContextStats:
    """Compute the per-turn context baseline for the detail page.

    ``per_turn_tokens`` is the honest number: in retrieval mode it's the
    instructions plus a top-k retrieval budget; in full-dump mode it's
    the instructions plus the entire pinned text.
    """
    instruction_tokens = _estimate_tokens(system_prompt)
    pinned_file_tokens = await _indexed_token_total(db, workspace_id)
    cfg = await get_embedding_config(db)
    embeddings_configured = cfg is not None
    retrieval_active = (
        embeddings_configured and pinned_file_tokens > WORKSPACE_RETRIEVAL_TOKEN_BUDGET
    )
    # Files still mid-index — surfaced so the UI can show "indexing N…".
    indexing_count = int(
        await db.scalar(
            select(func.count())
            .select_from(WorkspaceFile)
            .where(
                WorkspaceFile.workspace_id == workspace_id,
                WorkspaceFile.indexing_status.in_(("queued", "embedding")),
            )
        )
        or 0
    )
    if retrieval_active:
        # ~top_k chunks of ~500 tokens each, capped by what's indexed.
        per_turn = instruction_tokens + min(
            pinned_file_tokens, WORKSPACE_RETRIEVAL_TOP_K * 500
        )
    else:
        per_turn = instruction_tokens + pinned_file_tokens
    return WorkspaceContextStats(
        instruction_tokens=instruction_tokens,
        pinned_file_tokens=pinned_file_tokens,
        per_turn_tokens=per_turn,
        retrieval_active=retrieval_active,
        indexing_count=indexing_count,
        embeddings_configured=embeddings_configured,
    )


# ---------------------------------------------------------------------
# Auto-memory (opt-in)
# ---------------------------------------------------------------------

# Source-kind marker for the single auto-maintained memory file per
# workspace. Distinct from the manual "Save summary to workspace" files
# (``chat_summary``) so we can find + replace exactly one of them.
WORKSPACE_MEMORY_SOURCE_KIND = "workspace_memory"

# Per-workspace cooldown so a burst of turns doesn't re-summarise on every
# message. In-memory + best-effort — resets on restart, which is fine
# (worst case is one extra summary after a deploy).
_MEMORY_COOLDOWN_SECONDS = 180.0
_last_memory_run: dict[str, float] = {}

# Char cap on the workspace-documents block fed to the librarian (notes,
# sheets, canvases, boards). Keeps the merge prompt bounded so a few big
# docs can't crowd out the chat signal (~3k tokens of documents).
_MEMORY_DOCS_CHAR_CAP = 12000


async def get_workspace_memory_doc(
    db: AsyncSession, workspace_id: uuid.UUID
) -> UserFile | None:
    """The workspace's single auto-maintained memory file, if one exists.

    There is at most one per workspace (the librarian retires the old row
    each refresh), identified by ``source_kind == workspace_memory``."""
    return (
        (
            await db.execute(
                select(UserFile)
                .join(WorkspaceFile, WorkspaceFile.file_id == UserFile.id)
                .where(
                    WorkspaceFile.workspace_id == workspace_id,
                    UserFile.source_kind == WORKSPACE_MEMORY_SOURCE_KIND,
                )
            )
        )
        .scalars()
        .first()
    )


async def save_workspace_memory(
    db: AsyncSession, *, ws: Workspace, content_md: str
) -> uuid.UUID | None:
    """Create or replace the workspace memory doc with user-supplied Markdown.

    Lets a user hand-edit what the librarian stored (or seed it before any
    auto-run). Overwrites the existing pinned file in place when present so
    its id — and thus its pin + any references — stay stable. Returns the
    file id to (re)index, or ``None`` when the workspace has no resolvable
    owner. The caller re-indexes so the edit participates in retrieval."""
    from app.files.generated import (
        GeneratedFileError,
        overwrite_generated_file,
        persist_generated_file,
    )

    owner = await db.get(User, ws.user_id)
    if owner is None:
        return None

    body = content_md.strip() or f"# Workspace Memory: {ws.title}"
    data = (body + "\n").encode("utf-8")

    existing = await get_workspace_memory_doc(db, ws.id)
    if existing is not None:
        try:
            await overwrite_generated_file(
                db, user=owner, file=existing, content=data
            )
        except GeneratedFileError:
            return None
        # ``overwrite_generated_file`` committed the byte/size change; refresh
        # the extracted text too so the AI (and the next GET) see the edit
        # even before re-indexing populates embeddings.
        existing.content_text = body
        ws.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return existing.id

    try:
        new_uf = await persist_generated_file(
            db,
            user=owner,
            filename="Workspace Memory.md",
            mime_type="text/markdown",
            content=data,
            source_kind=WORKSPACE_MEMORY_SOURCE_KIND,
        )
    except GeneratedFileError:
        return None
    new_uf.content_text = body
    db.add(
        WorkspaceFile(workspace_id=ws.id, file_id=new_uf.id, pinned_by=owner.id)
    )
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return new_uf.id


# ---------------------------------------------------------------------
# Sticky / pinned memory — a fenced block the librarian preserves verbatim
# ---------------------------------------------------------------------
# Invisible HTML-comment fences (don't render in Markdown) bound a region of
# the memory the auto-librarian must never rewrite. We strip it before the
# merge (so the model never echoes or mangles it) and re-attach it verbatim
# after. "Save to memory" appends here, so saved facts are sticky by nature.
_PINNED_START = "<!-- pinned:start -->"
_PINNED_END = "<!-- pinned:end -->"
_PINNED_HEADING = "## 📌 Pinned (kept verbatim — never auto-changed)"
_PINNED_RE = re.compile(
    re.escape(_PINNED_START) + r"(.*?)" + re.escape(_PINNED_END),
    re.DOTALL,
)


def split_pinned_memory(md: str) -> tuple[str, str]:
    """Split memory markdown into ``(pinned_inner, rest)``.

    ``pinned_inner`` is the bullet content between the pinned fences (the
    canonical heading stripped), trimmed; ``rest`` is the markdown with the
    whole fenced block removed. Both empty-safe."""
    m = _PINNED_RE.search(md or "")
    if not m:
        return "", (md or "").strip()
    kept: list[str] = []
    for ln in m.group(1).splitlines():
        s = ln.strip()
        if s.startswith("## ") and "Pinned" in s:
            continue  # drop the heading; re-rendered canonically
        kept.append(ln)
    pinned_inner = "\n".join(kept).strip()
    rest = ((md[: m.start()] + md[m.end():]) or "").strip()
    return pinned_inner, rest


def compose_with_pinned(body: str, pinned_inner: str) -> str:
    """Re-attach the fenced pinned block to ``body``. No-op when empty."""
    body = (body or "").strip()
    pinned_inner = (pinned_inner or "").strip()
    if not pinned_inner:
        return body
    block = f"{_PINNED_START}\n{_PINNED_HEADING}\n\n{pinned_inner}\n{_PINNED_END}"
    return (body + "\n\n" + block) if body else block


async def append_to_workspace_memory(
    db: AsyncSession, *, ws: Workspace, text: str
) -> uuid.UUID | None:
    """Append ``text`` as a pinned bullet in the workspace memory, creating the
    doc if needed. Pinned items survive librarian runs verbatim, so this is the
    workspace-scoped "remember this". Returns the file id to (re)index."""
    snippet = " ".join((text or "").split())
    if not snippet:
        return None
    if len(snippet) > 2000:
        snippet = snippet[:2000].rstrip() + "…"

    existing = await get_workspace_memory_doc(db, ws.id)
    current = (existing.content_text or "").strip() if existing is not None else ""
    pinned_inner, rest = split_pinned_memory(current)
    bullet = f"- {snippet}"
    pinned_inner = (pinned_inner + "\n" + bullet).strip() if pinned_inner else bullet
    if not rest:
        rest = f"# Workspace Memory: {ws.title}"
    new_md = compose_with_pinned(rest, pinned_inner)
    return await save_workspace_memory(db, ws=ws, content_md=new_md)


_REMEMBER_SYSTEM_PROMPT = (
    "You maintain a workspace's living 'Workspace Memory' — a compact, "
    "accurate Markdown record of what's been established. You are given the "
    "CURRENT memory (which may be empty) and a single FACT the user has "
    "explicitly flagged to remember. Integrate that fact into the memory:\n"
    "- Treat it as a confirmed, durable user statement (high signal).\n"
    "- Decide WHERE it belongs and place it there; merge with or supersede any "
    "related existing entry instead of duplicating; tighten the wording.\n"
    "- PRESERVE everything else in the current memory that still holds.\n\n"
    "OUTPUT (Markdown only, no preamble or meta-commentary):\n"
    "- `## Workspace overview` — one or two sentences: the project's goal.\n"
    "- `## Durable facts` — bullets of always-true things. Omit if none.\n"
    "- `## Decisions` — bullets of concrete choices. Omit if none.\n"
    "- `## Open questions` — bullets of unresolved threads. Omit if none.\n"
    "- `## Next steps` — bullets of upcoming actions. Omit if none.\n\n"
    "RULES: third person; merge and deduplicate; never keep contradictions; "
    "under 700 words; no commentary about being a summary."
)


async def integrate_into_workspace_memory(
    db: AsyncSession, *, ws: Workspace, text: str
) -> uuid.UUID | None:
    """LLM-mediated "remember this": hand a user-flagged snippet to the memory
    model, which decides how and where to fold it into the memory document
    (right section, merge/supersede, tighten wording). Falls back to a verbatim
    pinned append when no memory model is resolvable or the call fails, so the
    fact is never lost. Returns the file id to (re)index."""
    from app.models_config.provider import ChatMessage, model_router

    snippet = " ".join((text or "").split())
    if not snippet:
        return None

    mem_provider_id = ws.memory_provider_id or ws.default_provider_id
    mem_model_id = ws.memory_model_id or ws.default_model_id
    if not mem_provider_id or not mem_model_id:
        return await append_to_workspace_memory(db, ws=ws, text=text)
    provider = await db.get(ModelProvider, mem_provider_id)
    if provider is None or not provider.enabled:
        return await append_to_workspace_memory(db, ws=ws, text=text)

    existing = await get_workspace_memory_doc(db, ws.id)
    full = (existing.content_text or "").strip() if existing is not None else ""
    pinned_inner, current = split_pinned_memory(full)

    parts = ["=== CURRENT WORKSPACE MEMORY ===\n" + (current or "(empty)")]
    if pinned_inner:
        parts.append(
            "=== PINNED (preserved separately; do NOT reproduce these) ===\n"
            + pinned_inner
        )
    parts.append(
        "=== FACT TO REMEMBER (the user explicitly clicked 'remember' on "
        "this) ===\n" + snippet
    )
    merged_input = "\n\n".join(parts)

    try:
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=mem_model_id,
            messages=[ChatMessage(role="user", content=merged_input)],
            system=_REMEMBER_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=1500,
        ):
            chunks.append(token)
        memo = "".join(chunks).strip()
    except Exception:  # noqa: BLE001 - provider or any failure → fall back
        logger.debug("workspace-memory: remember integrate failed for %s", ws.id)
        return await append_to_workspace_memory(db, ws=ws, text=text)

    if not memo:
        return await append_to_workspace_memory(db, ws=ws, text=text)

    # Re-attach the pinned block verbatim and persist over the existing doc.
    memo_body = compose_with_pinned(memo, pinned_inner)
    body = (
        f"# Workspace Memory: {ws.title}\n\n"
        f"_Maintained from this workspace's chats, documents, and saved "
        f"notes._\n\n{memo_body}\n"
    )
    return await save_workspace_memory(db, ws=ws, content_md=body)


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
    "You are the librarian for a workspace's living 'Workspace Memory' — a "
    "compact, accurate record of what has been established across its chats. "
    "You are given the CURRENT memory (which may be empty), RECENT CHAT "
    "EXCERPTS, the workspace's own DOCUMENTS (notes, sheets, canvases, "
    "boards), and possibly PINNED FACTS the user has locked. Mine the first "
    "three for durable signal; treat PINNED FACTS as authoritative but NEVER "
    "reproduce or alter them (they are preserved automatically). Produce the "
    "UPDATED memory document.\n\n"
    "WHAT TO CAPTURE (durable signal):\n"
    "- The user's explicit decisions and commitments (\"let's use X\", \"go "
    "with B\", \"the goal is Y\").\n"
    "- Established facts, constraints, preferences, names, versions, scope.\n"
    "- The project's overall goal.\n\n"
    "WHAT TO IGNORE (noise):\n"
    "- Options or possibilities the ASSISTANT merely offered (\"here are three "
    "ways…\") — these are NOT decisions until the user endorses one.\n"
    "- Exploration, brainstorming, questions, hypotheticals, small talk.\n"
    "- Anything tentative (\"maybe\", \"not sure\") — at most note it under "
    "Open questions, never as a fact or decision.\n"
    "The signal is USER ENDORSEMENT: the assistant suggesting something is not "
    "signal; the user choosing it is.\n\n"
    "UPDATING & CONFLICTS:\n"
    "- PRESERVE everything in the current memory that still holds — do NOT drop "
    "a fact just because the recent chats didn't mention it.\n"
    "- When new material CHANGES a prior entry on the SAME subject, SUPERSEDE "
    "it: replace the old value with the new one — do NOT keep both "
    "contradicting each other. You may briefly note the change, e.g. \"Dog "
    "name: D (changed from B)\". The newest explicit user decision wins.\n"
    "- When new material is about a DIFFERENT subject, ADD it.\n"
    "- If the user re-opens a settled question without deciding, move it from "
    "Decisions to Open questions.\n\n"
    "OUTPUT (Markdown only, no preamble or meta-commentary):\n"
    "- `## Workspace overview` — one or two sentences: the project's goal.\n"
    "- `## Durable facts` — bullets of things always true: stack, constraints, "
    "preferences, names, versions. Omit if none.\n"
    "- `## Decisions` — bullets of concrete choices the user has committed to. "
    "Omit if none.\n"
    "- `## Open questions` — bullets of unresolved/tentative threads. Omit if "
    "none.\n"
    "- `## Next steps` — bullets of upcoming actions. Omit if none.\n\n"
    "RULES:\n"
    "- Third person (\"The user …\").\n"
    "- Merge and deduplicate; never list the same fact twice or keep "
    "contradictions.\n"
    "- Under 700 words; aim for 350-500.\n"
    "- No commentary about being a summary or about these instructions."
)


def mark_memory_refreshed(workspace_id: uuid.UUID) -> None:
    """Stamp the per-workspace debounce clock — call after a manual
    regenerate so the automatic path doesn't immediately redo the work."""
    _last_memory_run[str(workspace_id)] = time.monotonic()


async def regenerate_workspace_memory(
    db: AsyncSession,
    *,
    ws: Workspace,
    fallback_conv: Conversation | None = None,
) -> tuple[uuid.UUID | None, int]:
    """Distil the workspace's recent chats into the rolling memory doc.

    The shared core behind both the automatic librarian and the manual
    "Regenerate now" action. Pulls up to :data:`_MEMORY_SOURCE_CONV_COUNT`
    recently-active conversations, merges them with the *current* memory,
    asks the configured memory model for an updated document, and persists
    it — retiring the prior pinned file. Returns ``(file_id, chat_count)``;
    ``file_id`` is ``None`` on any soft-fail (no model resolvable, no usable
    chats, empty model output). The caller owns gating, the session, and
    re-indexing the returned file.
    """
    from app.files.generated import GeneratedFileError, persist_generated_file
    from app.models_config.provider import ChatMessage, model_router

    # Resolve the memory model: the workspace's dedicated pick, else its
    # default chat model, else the fallback conversation's model. Lets a
    # creator on a machine that can't run Ollama point memory at an API model.
    mem_provider_id = (
        ws.memory_provider_id
        or ws.default_provider_id
        or (fallback_conv.provider_id if fallback_conv else None)
    )
    mem_model_id = (
        ws.memory_model_id
        or ws.default_model_id
        or (fallback_conv.model_id if fallback_conv else None)
    )
    if not mem_provider_id or not mem_model_id:
        return None, 0
    provider = await db.get(ModelProvider, mem_provider_id)
    if provider is None or not provider.enabled:
        return None, 0

    recent_convs = list(
        (
            await db.execute(
                select(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.temporary_mode.is_(None),
                )
                .order_by(Conversation.updated_at.desc())
                .limit(_MEMORY_SOURCE_CONV_COUNT)
            )
        )
        .scalars()
        .all()
    )
    # Build per-conversation transcripts, each capped to _MEMORY_BG_MSG_LIMIT
    # so the merged prompt stays bounded.
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

    # Also mine the workspace's own documents — durable decisions and facts
    # often live in a note, sheet, board, or canvas, not just in chat. Respect
    # the same per-item "use as workspace context" toggle, and cap the total
    # so a few big docs can't crowd out the chat signal.
    doc_excluded = await context_disabled_file_ids(db, ws.id)
    doc_sections: list[tuple[str, str]] = []
    for it, uf in await _workspace_notes(db, ws.id, doc_excluded):
        t = (uf.content_text or "").strip()
        if t:
            doc_sections.append((it.title or "Note", t))
    for it, cv in await _workspace_canvases(db, ws.id, doc_excluded):
        t = (cv.content_text or "").strip()
        if t:
            doc_sections.append((f"{it.title or 'Canvas'} (canvas)", t))
    for it, uf in await _workspace_boards(db, ws.id, doc_excluded):
        t = (uf.content_text or "").strip()
        if t:
            doc_sections.append((f"{it.title or 'Board'} (board)", t))
    for it, sh in await _workspace_sheets(db, ws.id, doc_excluded):
        t = (sh.content_text or "").strip()
        if t:
            doc_sections.append((f"{it.title or 'Sheet'} (sheet)", t))

    docs_text = ""
    if doc_sections:
        buf: list[str] = []
        used = 0
        for title, text in doc_sections:
            seg = f"\n\n## {title}\n{text}"
            if used + len(seg) > _MEMORY_DOCS_CHAR_CAP:
                seg = seg[: max(0, _MEMORY_DOCS_CHAR_CAP - used)]
            buf.append(seg)
            used += len(seg)
            if used >= _MEMORY_DOCS_CHAR_CAP:
                break
        docs_text = "".join(buf).strip()

    # Nothing to distil from — no usable chats and no documents.
    if not excerpts and not docs_text:
        return None, 0

    # Load the current memory doc (if any) so the librarian *updates* it —
    # accumulating durable knowledge and superseding changed decisions —
    # rather than regenerating from only the last few chats. Split off the
    # pinned/sticky block first: the librarian never sees it as editable
    # content; it's re-attached verbatim after.
    existing = await get_workspace_memory_doc(db, ws.id)
    full_memory = (
        (existing.content_text or "").strip() if existing is not None else ""
    )
    pinned_inner, current_memory = split_pinned_memory(full_memory)

    parts: list[str] = []
    if current_memory:
        parts.append(
            "=== CURRENT WORKSPACE MEMORY (revise this; keep what still "
            "holds, supersede what changed) ===\n" + current_memory
        )
    if pinned_inner:
        parts.append(
            "=== PINNED FACTS (the user locked these; treat them as "
            "authoritative, but DO NOT reproduce or modify them in your "
            "output — they are preserved automatically) ===\n" + pinned_inner
        )
    if excerpts:
        parts.append(
            "=== RECENT CHAT EXCERPTS (new material to mine for durable "
            "signal) ===\n" + "\n\n".join(excerpts)
        )
    if docs_text:
        parts.append(
            "=== WORKSPACE DOCUMENTS (notes, sheets, canvases, boards — mine "
            "these for durable signal too) ===\n" + docs_text
        )
    merged_input = "\n\n".join(parts)

    try:
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=mem_model_id,
            messages=[ChatMessage(role="user", content=merged_input)],
            system=_MERGE_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=1500,
        ):
            chunks.append(token)
        memo = "".join(chunks).strip()
    except Exception:  # noqa: BLE001 - ProviderError or any other failure
        logger.debug("workspace-memory: merge call failed for workspace %s", ws.id)
        return None, 0

    if not memo:
        return None, 0

    owner = await db.get(User, ws.user_id)
    if owner is None:
        return None, 0

    conv_count = len(recent_convs)
    src_bits: list[str] = []
    if excerpts:
        src_bits.append(
            f"the last {len(excerpts)} active chat"
            f"{'s' if len(excerpts) > 1 else ''}"
        )
    if doc_sections:
        src_bits.append("the workspace's notes, sheets, canvases, and boards")
    source_desc = " and ".join(src_bits) or "this workspace"
    # Re-attach the pinned block verbatim — the librarian never touched it.
    memo_body = compose_with_pinned(memo, pinned_inner)
    body = (
        f"# Workspace Memory: {ws.title}\n\n"
        f"_Auto-maintained from {source_desc}. Turn this off in Settings._\n\n"
        f"{memo_body}\n"
    )

    try:
        new_uf = await persist_generated_file(
            db,
            user=owner,
            filename="Workspace Memory.md",
            mime_type="text/markdown",
            content=body.encode("utf-8"),
            source_kind=WORKSPACE_MEMORY_SOURCE_KIND,
        )
    except GeneratedFileError:
        return None, 0

    # Set ``content_text`` directly so the doc reads back correctly even when
    # embeddings aren't configured (the re-index that populates it is a no-op
    # in that case). This is also what the next merge loads as current memory.
    new_uf.content_text = body
    db.add(WorkspaceFile(workspace_id=ws.id, file_id=new_uf.id, pinned_by=owner.id))
    if existing is not None:
        await db.execute(
            delete(WorkspaceFile).where(
                WorkspaceFile.workspace_id == ws.id,
                WorkspaceFile.file_id == existing.id,
            )
        )
        await db.delete(existing)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return new_uf.id, conv_count


async def maybe_refresh_workspace_memory(conversation_id: uuid.UUID) -> None:
    """Refresh a workspace's rolling 'Workspace Memory' when it has
    ``auto_memory_enabled`` — the automatic, debounced wrapper around
    :func:`regenerate_workspace_memory`.

    Owns its own session (spawned via ``asyncio.create_task`` from the
    stream finalize). Entirely best-effort; every failure path is a quiet
    return. Debounced per workspace.
    """
    async with SessionLocal() as db:
        conv = await db.get(Conversation, conversation_id)
        if conv is None or conv.workspace_id is None:
            return
        ws = await db.get(Workspace, conv.workspace_id)
        # Only the "auto" mode auto-maintains; "manual" and "off" never run
        # the librarian on a chat finalize.
        if ws is None or ws.memory_mode != "auto":
            return

        key = str(ws.id)
        now = time.monotonic()
        if (now - _last_memory_run.get(key, 0.0)) < _MEMORY_COOLDOWN_SECONDS:
            return
        _last_memory_run[key] = now

        ws_id = ws.id
        file_id, conv_count = await regenerate_workspace_memory(
            db, ws=ws, fallback_conv=conv
        )

    if file_id is None:
        return
    # Index the fresh memory file so it participates in retrieval.
    await index_file_for_workspace(ws_id, file_id, force=True)
    logger.info(
        "auto-memory refreshed for workspace %s (merged %d chats)",
        ws_id,
        conv_count,
    )

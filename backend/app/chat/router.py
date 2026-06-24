"""Chat API — conversations CRUD, send message, SSE streaming."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.audit import (
    EVENT_BUDGET_EXCEEDED,
    EVENT_TOOL_FAILED,
    EVENT_TOOL_INVOKED,
    record_event,
    safe_dict,
)
from app.auth.deps import get_current_user
from app.auth.models import User
from app.billing.usage import check_budget, maybe_alert_admins, record_usage
from app.chat.models import (
    CompareGroup,
    Conversation,
    ConversationExcludedWorkspaceFile,
    Message,
    Workspace,
    WorkspaceFile,
)
from app.workspaces.schemas import (
    ConversationWorkspaceFile,
    ToggleWorkspaceFileRequest,
)
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)
from app.chat.schemas import (
    BranchConversationRequest,
    CompactionResponse,
    ConversationCreate,
    ConversationDetail,
    ConversationSearchHit,
    ConversationSummary,
    ConversationUpdate,
    ArtifactEditRequest,
    ArtifactEditResponse,
    EditMessageRequest,
    EnhancePromptRequest,
    EnhancePromptResponse,
    MentionCandidate,
    MentionCandidatesResponse,
    MentionFileCandidate,
    MessageResponse,
    MessageFeedbackRequest,
    PatchAssistantMessageRequest,
    RegenerateMessageRequest,
    SendMessageRequest,
    SendMessageResponse,
    SummariseToWorkspaceResponse,
)
from app.chat.compaction import CompactionError, compact_conversation
from app.chat.mentions import (
    build_file_mention_block,
    build_reference_system_block,
    extract_file_mentions,
    extract_mentions,
    resolve_mentions,
)
from app.chat.summariser import (
    SummariseError,
    summarise_conversation_to_markdown,
)
from app.chat.shares import (
    get_accessible_conversation,
    list_accessible_conversation_ids,
    load_participants,
)
from app.chat.service import (
    StreamContext,
    consume_stream,
    enqueue_stream,
    peek_stream,
)
from app.chat.stream_runner import (
    StreamSession,
    find_active_for_conversation,
    get_or_create_session,
    get_session,
)
from app.chat.personal_context import build_personal_context_prompt
from app.chat.semantic_search import (
    embed_query,
    get_embedding_config,
    semantic_search_messages,
)
from app.memory.constants import RETRIEVAL_K as MEMORY_RETRIEVAL_K
from app.memory.service import (
    build_memory_system_prompt,
    capture_memories,
    should_attempt_capture,
)
from app.chat.titler import fallback_title, generate_conversation_title
from app.chat.versioning import (
    active_path,
    descend_to_leaf,
    lineage_to,
    version_meta,
)
from app.chat.tools import (
    ToolContext,
    ToolError,
    build_tools_system_prompt,
    get_tool,
    list_openai_tools,
)
from app.database import SessionLocal, get_db
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.models import UserFile
from app.files.prompt import (
    build_attachment_preamble,
    build_image_parts,
    looks_image,
)
from app.files.router import attachment_snapshot, resolve_attachments
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    ContentPart,
    FinishEvent,
    ImagePart,
    ProviderError,
    ReasoningDelta,
    TextDelta,
    TextPart,
    ToolCallDelta,
    UsageEvent,
    model_router,
)
from app.rate_limit import enforce_user_message_rate
from app.chat.base_prompt import PROMPTLY_BASE_PROMPT, VOICE_SYSTEM_PROMPT
from app.search.service import (
    canonicalise_url,
    distill_query,
    merge_system_prompt,
)

logger = logging.getLogger("promptly.chat")
router = APIRouter()


# ====================================================================
# Conversations CRUD
# ====================================================================
async def _get_owned_conversation(
    conversation_id: uuid.UUID, user: User, db: AsyncSession
) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    return conv


# --------------------------------------------------------------------
# Full-text search across the user's conversations
# --------------------------------------------------------------------
def _to_websearch_query(raw: str) -> str:
    """Sanitise the user-typed query for ``websearch_to_tsquery``.

    Postgres' ``websearch_to_tsquery`` already handles user-friendly
    syntax (quoted phrases, ``OR``, ``-not``) so we mostly just trim
    and bound the input. We keep the original string and let Postgres
    parse it; the function never raises on garbage so there's no need
    to escape further.
    """
    return (raw or "").strip()[:200]


@router.get("/conversations/search", response_model=list[ConversationSearchHit])
async def search_conversations(
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    workspace_id: uuid.UUID | None = Query(default=None),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationSearchHit]:
    """Full-text search across the caller's conversation history.

    Matches against the ``content_tsv`` GIN index added in 0017 so a
    multi-thousand-message archive resolves in single-digit ms.
    Returns at most ``limit`` rows, ordered by ts_rank desc, with
    ``ts_headline`` snippets the frontend renders verbatim (the
    ``<mark>…</mark>`` wrapping is sanitised by the markdown
    renderer's allowlist).

    Searches the caller's own conversations plus any chat inside a
    workspace shared with them. When ``workspace_id`` is given, results are
    scoped to chats inside that workspace (intersected with the caller's
    accessible set, so it never widens access — an inaccessible workspace
    just yields no results).

    The optional ``start`` / ``end`` instants bound matches by
    ``created_at`` (``start`` inclusive, ``end`` exclusive). They can be
    supplied *with* a text query (filter the search) or *without* one
    (browse mode — list the chats active in that window, newest first).
    The frontend resolves the user's local day boundaries to UTC before
    sending, so the range means what the user picked in their timezone.
    """
    cleaned = _to_websearch_query(q) if q else ""
    has_date_filter = start is not None or end is not None
    # Need something to search on: a text query, a date range, or both.
    if not cleaned and not has_date_filter:
        return []

    # Search across owned chats *and* workspace-shared chats.
    # Pre-resolving the id list keeps the FTS query simple and lets
    # Postgres reuse the GIN index without a wider join.
    accessible_ids = await list_accessible_conversation_ids(user, db)
    if not accessible_ids:
        return []

    if workspace_id is not None:
        ws_conv_ids = set(
            (
                await db.execute(
                    select(Conversation.id).where(
                        Conversation.workspace_id == workspace_id
                    )
                )
            )
            .scalars()
            .all()
        )
        accessible_ids = [cid for cid in accessible_ids if cid in ws_conv_ids]
        if not accessible_ids:
            return []

    # Optional ``created_at`` range, ANDed into every retriever below.
    # ``start`` is inclusive, ``end`` exclusive — the frontend already
    # resolved local day boundaries to UTC instants, so we just bind them.
    date_sql = ""
    date_params: dict[str, datetime] = {}
    if start is not None:
        date_sql += " AND m.created_at >= :start"
        date_params["start"] = start
    if end is not None:
        date_sql += " AND m.created_at < :end"
        date_params["end"] = end

    # Date-only browse: no text query, just "which chats did I touch in
    # this window". Returns one representative hit per conversation (its
    # latest message in range), newest-first.
    if not cleaned:
        return await _browse_conversations_by_date(
            db,
            conv_ids=accessible_ids,
            user_id=user.id,
            date_sql=date_sql,
            date_params=date_params,
            limit=limit,
        )

    # Pull a wider slate from each retriever than the caller asked for so
    # the fusion below has material to re-rank before we trim to ``limit``.
    fetch = min(50, max(limit * 2, 30))

    fts_sql = text(
        f"""
        SELECT
            m.conversation_id            AS conversation_id,
            m.id                         AS message_id,
            c.title                      AS conversation_title,
            m.role                       AS role,
            ts_headline(
                'english',
                m.content,
                websearch_to_tsquery('english', :q),
                'StartSel=[[HL]], StopSel=[[/HL]], MaxWords=18, MinWords=6,'
                ' ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "'
            )                            AS snippet,
            ts_rank(m.content_tsv, websearch_to_tsquery('english', :q)) AS rank,
            m.created_at                 AS created_at,
            CASE
                WHEN c.user_id = :user_id THEN 'owner'
                ELSE 'collaborator'
            END                          AS access
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = ANY(:conv_ids)
          AND c.archived_at IS NULL
          AND m.content_tsv @@ websearch_to_tsquery('english', :q)
          {date_sql}
        ORDER BY rank DESC, m.created_at DESC
        LIMIT :limit
        """
    )
    fts_rows = (
        await db.execute(
            fts_sql,
            {
                "q": cleaned,
                "conv_ids": accessible_ids,
                "limit": fetch,
                "user_id": user.id,
                **date_params,
            },
        )
    ).mappings().all()

    # Semantic recall — best-effort. Returns nothing when embeddings
    # aren't configured or the embed call fails, so the palette silently
    # falls back to pure keyword search.
    sem_rows: list[dict] = []
    cfg = await get_embedding_config(db)
    if cfg is not None:
        qvec = await embed_query(cfg, cleaned)
        if qvec is not None:
            sem_rows = await semantic_search_messages(
                db,
                qvec=qvec,
                cfg=cfg,
                conv_ids=accessible_ids,
                user_id=user.id,
                limit=fetch,
                start=start,
                end=end,
            )

    return _fuse_search_hits(fts_rows, sem_rows, limit=limit)


# ---------------------------------------------------------------------
# Per-chat workspace-file opt-out (Phase 4)
# ---------------------------------------------------------------------


@router.get(
    "/conversations/{conversation_id}/workspace-files",
    response_model=list[ConversationWorkspaceFile],
)
async def list_conversation_workspace_files(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationWorkspaceFile]:
    """List the workspace's pinned files with each one's per-chat
    excluded flag. Empty when the chat isn't in a workspace."""
    conv, _role = await get_accessible_conversation(conversation_id, user, db)
    if conv.workspace_id is None:
        return []
    pins = (
        await db.execute(
            select(WorkspaceFile, UserFile)
            .join(UserFile, UserFile.id == WorkspaceFile.file_id)
            .where(WorkspaceFile.workspace_id == conv.workspace_id)
            .order_by(WorkspaceFile.pinned_at.asc())
        )
    ).all()
    excluded = set(
        (
            await db.execute(
                select(ConversationExcludedWorkspaceFile.file_id).where(
                    ConversationExcludedWorkspaceFile.conversation_id == conv.id
                )
            )
        )
        .scalars()
        .all()
    )
    return [
        ConversationWorkspaceFile(
            file_id=uf.id,
            filename=uf.filename,
            mime_type=uf.mime_type,
            excluded=uf.id in excluded,
        )
        for _pin, uf in pins
    ]


@router.put(
    "/conversations/{conversation_id}/workspace-files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def toggle_conversation_workspace_file(
    conversation_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: ToggleWorkspaceFileRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Include / exclude one of the workspace's pinned files for *this*
    chat. Only the chat's owner can change its context."""
    conv, _role = await get_accessible_conversation(conversation_id, user, db)
    if conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the chat's owner can change which files it sees.",
        )
    if conv.workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This chat isn't in a workspace.",
        )
    existing = await db.get(
        ConversationExcludedWorkspaceFile, (conv.id, file_id)
    )
    if payload.excluded and existing is None:
        db.add(
            ConversationExcludedWorkspaceFile(
                conversation_id=conv.id, file_id=file_id
            )
        )
        await db.commit()
    elif not payload.excluded and existing is not None:
        await db.delete(existing)
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Reciprocal-rank-fusion constant. The standard k=60 from the RRF paper —
# damps the contribution of deep results so the head of each list
# dominates without one retriever's raw scores swamping the other.
_RRF_K = 60


def _synth_snippet(content: str, max_chars: int = 200) -> str:
    """Plain (un-highlighted) excerpt for a semantic-only hit, which has
    no ``ts_headline`` markers of its own."""
    text_ = " ".join((content or "").split())
    if len(text_) <= max_chars:
        return text_
    return text_[:max_chars].rstrip() + " …"


async def _browse_conversations_by_date(
    db: AsyncSession,
    *,
    conv_ids: list[uuid.UUID],
    user_id: uuid.UUID,
    date_sql: str,
    date_params: dict[str, datetime],
    limit: int,
) -> list[ConversationSearchHit]:
    """List conversations with activity in a date range (no text query).

    One row per conversation — its most recent message inside the window —
    ordered newest-first. Powers the palette's "browse by date" mode where
    the user just wants to see which chats they touched in a period. The
    ``DISTINCT ON`` collapses each conversation to its latest in-range
    message; the outer query then orders those representatives globally and
    trims to ``limit``.
    """
    sql = text(
        f"""
        SELECT sub.* FROM (
            SELECT DISTINCT ON (m.conversation_id)
                m.conversation_id            AS conversation_id,
                m.id                         AS message_id,
                c.title                      AS conversation_title,
                m.role                       AS role,
                m.content                    AS content,
                m.created_at                 AS created_at,
                CASE
                    WHEN c.user_id = :user_id THEN 'owner'
                    ELSE 'collaborator'
                END                          AS access
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = ANY(:conv_ids)
              AND c.archived_at IS NULL
              {date_sql}
            ORDER BY m.conversation_id, m.created_at DESC
        ) sub
        ORDER BY sub.created_at DESC
        LIMIT :limit
        """
    )
    rows = (
        await db.execute(
            sql,
            {
                "conv_ids": conv_ids,
                "user_id": user_id,
                "limit": limit,
                **date_params,
            },
        )
    ).mappings().all()
    return [
        ConversationSearchHit(
            conversation_id=r["conversation_id"],
            message_id=r["message_id"],
            conversation_title=r["conversation_title"],
            role=r["role"],
            snippet=_synth_snippet(str(r["content"] or "")),
            rank=0.0,
            created_at=r["created_at"],
            access=r["access"],
            match="keyword",
        )
        for r in rows
    ]


def _fuse_search_hits(
    fts_rows: list,
    sem_rows: list[dict],
    *,
    limit: int,
) -> list[ConversationSearchHit]:
    """Blend keyword + semantic results with reciprocal rank fusion.

    A message that surfaces in both lists is boosted (its fused score is
    the sum of both contributions) and tagged ``hybrid``; otherwise it's
    ``keyword`` or ``semantic``. Keyword hits keep their highlighted
    ``ts_headline`` snippet; semantic-only hits get a plain excerpt.
    """
    fused: dict = {}

    def _slot(mid, row, *, source: str):
        entry = fused.get(mid)
        if entry is None:
            entry = {"row": row, "score": 0.0, "sources": set()}
            fused[mid] = entry
        entry["sources"].add(source)
        # Prefer the keyword row as the canonical source for snippet/rank
        # since it carries highlight markers.
        if source == "keyword":
            entry["row"] = row
        return entry

    for pos, r in enumerate(fts_rows):
        entry = _slot(r["message_id"], r, source="keyword")
        entry["score"] += 1.0 / (_RRF_K + pos + 1)

    for pos, r in enumerate(sem_rows):
        entry = _slot(r["message_id"], r, source="semantic")
        entry["score"] += 1.0 / (_RRF_K + pos + 1)
        entry.setdefault("sem_row", r)

    ranked = sorted(fused.values(), key=lambda e: e["score"], reverse=True)

    hits: list[ConversationSearchHit] = []
    for entry in ranked[:limit]:
        sources = entry["sources"]
        if {"keyword", "semantic"} <= sources:
            match = "hybrid"
        elif "semantic" in sources:
            match = "semantic"
        else:
            match = "keyword"

        row = entry["row"]
        if "keyword" in sources:
            snippet = str(row.get("snippet") or "")
        else:
            snippet = _synth_snippet(str(row.get("content") or ""))

        hits.append(
            ConversationSearchHit(
                conversation_id=row["conversation_id"],
                message_id=row["message_id"],
                conversation_title=row["conversation_title"],
                role=row["role"],
                snippet=snippet,
                rank=float(entry["score"]),
                created_at=row["created_at"],
                access=row["access"],
                match=match,
            )
        )
    return hits


@router.get(
    "/conversations/mention-candidates",
    response_model=MentionCandidatesResponse,
)
async def list_mention_candidates(
    q: str = Query(default="", max_length=200),
    workspace_id: uuid.UUID | None = Query(default=None),
    exclude_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=12, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MentionCandidatesResponse:
    """Autocomplete source for ``@`` mentions in the composer.

    Returns two lists (both ordered by most-recently-updated first):

    * ``workspace_candidates`` — sibling chats in the same workspace
      as the conversation the user is composing from. Surfaced
      first in the popover because references within a workspace
      are the common case.
    * ``recent_candidates`` — the caller's most recently active
      chats, workspace-agnostic.

    When ``q`` is non-empty, titles are filtered by a case-
    insensitive substring match (fuzzy enough without touching the
    FTS index). ``exclude_id`` is the conversation the user is
    composing from; we drop it from the results so ``@``-mentioning
    yourself is never an option.

    Scoped to owner-role conversations only for now — referencing
    a chat you don't own gets complicated (the referenced chat's
    owner can't see the reference, which is confusing) so we keep
    this tight in v1.
    """
    q_norm = q.strip().lower()

    # Base query: owned, non-compare-column, optionally filtered
    # by title substring. Compare columns that haven't been crowned
    # get filtered out the same way the sidebar does — they're
    # drafts, not meaningful references.
    base_select = (
        select(Conversation)
        .where(Conversation.user_id == user.id)
        # Archived chats aren't valid @-mention targets — they've been
        # put away, so keep them out of the autocomplete.
        .where(Conversation.archived_at.is_(None))
        .where(
            # Exclude uncrowned compare columns. A crowned compare
            # column becomes a normal chat (its ``compare_group_id``
            # stays set, but ``CompareGroup.crowned_conversation_id``
            # points at it); filtering by ``compare_group_id IS NULL``
            # alone would drop the winners too. The simplest stable
            # check: only exclude rows whose group exists *and*
            # hasn't crowned them. We do this as a correlated
            # ``NOT IN`` to keep the SQL readable.
            (Conversation.compare_group_id.is_(None))
            | (
                Conversation.id.in_(
                    select(CompareGroup.crowned_conversation_id).where(
                        CompareGroup.crowned_conversation_id.isnot(None)
                    )
                )
            )
        )
        .order_by(Conversation.updated_at.desc())
    )
    if exclude_id is not None:
        base_select = base_select.where(Conversation.id != exclude_id)
    if q_norm:
        base_select = base_select.where(
            func.lower(Conversation.title).like(f"%{q_norm}%")
        )

    workspace_rows: list[Conversation] = []
    workspace_file_candidates: list[MentionFileCandidate] = []
    if workspace_id is not None:
        # Verify the workspace belongs to the caller before including
        # its chats — a malicious client shouldn't be able to enumerate
        # titles in someone else's workspace by guessing the id.
        ws = await db.get(Workspace, workspace_id)
        if ws is not None and ws.user_id == user.id:
            ws_result = await db.execute(
                base_select.where(Conversation.workspace_id == workspace_id).limit(limit)
            )
            workspace_rows = list(ws_result.scalars().all())

            # Workspace files: every UserFile under the workspace's Drive
            # folder subtree (notes, uploads, canvas text files). Notes are
            # ``document`` rows; canvases ride their backing ``canvas_text``
            # file — all UserFiles, so they reference via the same
            # ``file:`` mention mechanism. Hidden inline doc assets are
            # excluded.
            if ws.root_folder_id is not None:
                # Prefer the navigator name over the backing filename: a
                # canvas's backing file is always "Untitled canvas.md" and a
                # note's file carries an extension. Notes carry their title on
                # ``workspace_items`` (ref_id → file); canvases carry it on
                # ``workspace_canvas`` (text_file_id → file). Match the query
                # against those titles too, so searching by the name the user
                # sees actually finds the canvas/note.
                file_rows = (
                    await db.execute(
                        text(
                            """
                            WITH RECURSIVE subtree AS (
                                SELECT id FROM file_folders WHERE id = :root
                                UNION ALL
                                SELECT f.id FROM file_folders f
                                JOIN subtree s ON f.parent_id = s.id
                            )
                            SELECT f.id, f.filename, f.source_kind,
                                   COALESCE(wi.title, wci.title, wc.title)
                                       AS display_title
                            FROM files f
                            LEFT JOIN workspace_items wi
                              ON wi.ref_id = f.id
                             AND wi.workspace_id = :wsid
                            LEFT JOIN workspace_canvas wc
                              ON wc.text_file_id = f.id
                             AND wc.workspace_id = :wsid
                            LEFT JOIN workspace_items wci
                              ON wci.ref_id = wc.id
                             AND wci.workspace_id = :wsid
                             AND wci.kind = 'canvas'
                            WHERE f.folder_id IN (SELECT id FROM subtree)
                              AND f.trashed_at IS NULL
                              AND (f.source_kind IS NULL
                                   OR f.source_kind <> 'document_asset')
                              AND (:q = ''
                                   OR lower(f.filename) LIKE :qlike
                                   OR lower(coalesce(wi.title, '')) LIKE :qlike
                                   OR lower(coalesce(wci.title, '')) LIKE :qlike
                                   OR lower(coalesce(wc.title, '')) LIKE :qlike)
                            ORDER BY f.updated_at DESC
                            LIMIT :lim
                            """
                        ),
                        {
                            "root": str(ws.root_folder_id),
                            "wsid": str(workspace_id),
                            "q": q_norm,
                            "qlike": f"%{q_norm}%",
                            "lim": limit,
                        },
                    )
                ).all()
                for fid, fname, skind, item_title in file_rows:
                    kind = (
                        "note"
                        if skind == "document"
                        else "canvas"
                        if skind == "canvas_text"
                        else "file"
                    )
                    workspace_file_candidates.append(
                        MentionFileCandidate(
                            id=fid,
                            filename=item_title or fname or "Untitled",
                            kind=kind,
                        )
                    )

    # Recents: the same base but *excluding* anything already in
    # workspace_rows so the two lists don't duplicate the same chat.
    already_ids = {c.id for c in workspace_rows}
    recent_select = base_select.limit(limit + len(already_ids))
    recent_result = await db.execute(recent_select)
    recent_rows: list[Conversation] = [
        c for c in recent_result.scalars().all() if c.id not in already_ids
    ][:limit]

    # Resolve workspace titles in a single batch so the popover can
    # render "In workspace: Acme SRE" next to each candidate.
    workspace_ids = {
        c.workspace_id
        for c in (*workspace_rows, *recent_rows)
        if c.workspace_id is not None
    }
    workspace_title_map: dict[uuid.UUID, str] = {}
    if workspace_ids:
        ws_title_result = await db.execute(
            select(Workspace.id, Workspace.title).where(
                Workspace.id.in_(workspace_ids)
            )
        )
        workspace_title_map = {wid: title for wid, title in ws_title_result.all()}

    def to_candidate(c: Conversation) -> MentionCandidate:
        return MentionCandidate(
            id=c.id,
            title=(c.title or "Untitled chat").strip() or "Untitled chat",
            workspace_id=c.workspace_id,
            workspace_title=(
                workspace_title_map.get(c.workspace_id) if c.workspace_id else None
            ),
            updated_at=c.updated_at,
        )

    return MentionCandidatesResponse(
        workspace_context_id=workspace_id,
        workspace_candidates=[to_candidate(c) for c in workspace_rows],
        recent_candidates=[to_candidate(c) for c in recent_rows],
        workspace_file_candidates=workspace_file_candidates,
    )


@router.get("/conversations", response_model=list[ConversationSummary])
async def list_conversations(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    archived: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationSummary]:
    """List conversations the caller owns.

    Per-chat sharing was removed, so the sidebar list is owned-only.
    (Chats inside a shared *project* are surfaced under the project
    view, not the global list.)

    ``archived`` flips the listing between the two surfaces: the default
    (``False``) returns the active sidebar list (``archived_at IS NULL``)
    ordered pinned-then-recent; ``True`` returns the Archive page's list
    (``archived_at IS NOT NULL``) ordered by most-recently-archived.
    """
    # Phase Z1 — temporary chat filtering:
    #   * Ephemeral chats are never listed; they're meant to be
    #     unfindable once the user navigates away.
    #   * Any expired chat (ephemeral or one_hour) is filtered out
    #     even if the sweeper hasn't reaped it yet, so the user never
    #     sees a stale row in the sidebar.
    # Compare mode (0029): non-crowned compare columns are hidden
    # from the main sidebar — they're only accessible via the
    # Compare view / archive. Once the user crowns a column it
    # becomes a first-class conversation and surfaces normally.
    now = datetime.now(timezone.utc)

    # Subquery of conversation ids that are part of an un-crowned
    # compare group (either still active or where the crown landed
    # on a *different* column). The main list excludes these.
    non_crowned_compare = (
        select(Conversation.id)
        .join(
            CompareGroup,
            Conversation.compare_group_id == CompareGroup.id,
        )
        .where(
            (CompareGroup.crowned_conversation_id.is_(None))
            | (CompareGroup.crowned_conversation_id != Conversation.id)
        )
        .subquery()
    )

    # Conversations the user has explicitly hidden from *their own*
    # sidebar ("remove from my history"). Parse the opaque id strings to
    # UUIDs, skipping any that don't parse so a malformed entry can't 500
    # the whole list.
    hidden_ids: list[uuid.UUID] = []
    for raw in (user.settings or {}).get("hidden_conversations", []) or []:
        try:
            hidden_ids.append(uuid.UUID(str(raw)))
        except (ValueError, TypeError, AttributeError):
            continue

    query = (
        select(Conversation)
        .where(Conversation.user_id == user.id)
        .where(
            (Conversation.temporary_mode.is_(None))
            | (Conversation.temporary_mode == "one_hour")
        )
        .where(
            (Conversation.expires_at.is_(None))
            | (Conversation.expires_at > now)
        )
        .where(Conversation.id.not_in(select(non_crowned_compare)))
    )
    # Archive split: the active list hides archived chats; the archive
    # list shows only them, newest-archived first.
    if archived:
        query = query.where(Conversation.archived_at.is_not(None))
    else:
        query = query.where(Conversation.archived_at.is_(None))
    if hidden_ids:
        query = query.where(Conversation.id.not_in(hidden_ids))
    order = (
        (Conversation.archived_at.desc(),)
        if archived
        else (Conversation.pinned.desc(), Conversation.updated_at.desc())
    )
    result = await db.execute(
        query
        .order_by(*order)
        .limit(limit)
        .offset(offset)
    )
    out: list[ConversationSummary] = []
    for c in result.scalars().all():
        summary = ConversationSummary.model_validate(c)
        summary.role = "owner"
        out.append(summary)
    return out


@router.post(
    "/conversations",
    response_model=ConversationSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_conversation(
    payload: ConversationCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    # Phase Z1 — temporary chats. Compute ``expires_at`` from the
    # requested mode so the sweeper has a wall-clock deadline; the
    # client never sets the timestamp itself.
    expires_at: datetime | None = None
    if payload.temporary_mode == "one_hour":
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
    elif payload.temporary_mode == "ephemeral":
        # 24h backstop — the frontend deletes proactively on
        # navigate-away, but if a tab crashes (or the user goes offline
        # mid-stream) the sweeper still cleans up eventually.
        expires_at = datetime.now(timezone.utc) + timedelta(hours=24)

    # Phase P1 — validate the requested workspace (if any). Ownership
    # is enforced here (not just on the workspaces endpoints) so a user
    # can't drop a chat into someone else's workspace via the create
    # payload; temporary + workspace is rejected because the sweeper
    # would otherwise need to think about cascading behaviour.
    workspace_id: uuid.UUID | None = None
    if payload.workspace_id is not None:
        if payload.temporary_mode is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Temporary chats can't belong to a workspace.",
            )
        # Owner or editor may start chats in the workspace; viewers can't.
        workspace, _wrole = await get_accessible_workspace(
            payload.workspace_id, user, db
        )
        require_workspace_write(_wrole)
        workspace_id = workspace.id
        # If the conversation didn't pick a model explicitly, inherit
        # the workspace's defaults — matches ChatGPT's behaviour where
        # opening a workspace-new-chat uses the workspace-level model.
        if payload.model_id is None and workspace.default_model_id:
            payload = payload.model_copy(
                update={"model_id": workspace.default_model_id}
            )
        if payload.provider_id is None and workspace.default_provider_id:
            payload = payload.model_copy(
                update={"provider_id": workspace.default_provider_id}
            )

    # Workspace-wide default chat model — final defensive fallback for
    # callers (e.g. older clients, scripted API access) that POST a
    # create-conversation payload without an explicit model pair.
    # Precedence is:
    #
    #   1. payload.model_id / payload.provider_id  (already set above)
    #   2. workspace defaults                      (handled in the
    #                                               ``workspace_id`` block)
    #   3. app_settings.default_chat_*_id          (THIS block)
    #
    # The personal default lives client-side on ``users.settings`` and
    # is folded into the payload by the frontend before the POST, so
    # by the time it reaches here a non-NULL payload pair has *already*
    # honoured the personal default. This admin fallback only fires
    # when both the personal default and the workspace defaults were
    # empty — i.e. a fresh user starting a top-level chat with no
    # preferences set anywhere.
    if payload.model_id is None or payload.provider_id is None:
        app_settings_row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        if app_settings_row is not None and app_settings_row.default_chat_configured:
            if payload.model_id is None:
                payload = payload.model_copy(
                    update={"model_id": app_settings_row.default_chat_model_id}
                )
            if payload.provider_id is None:
                payload = payload.model_copy(
                    update={
                        "provider_id": app_settings_row.default_chat_provider_id
                    }
                )

    conv = Conversation(
        user_id=user.id,
        title=payload.title,
        model_id=payload.model_id,
        provider_id=payload.provider_id,
        web_search_mode=payload.web_search_mode,
        # ``None`` here (the schema default) maps to a NULL column,
        # which the chat router treats as "use provider default" —
        # the right behaviour for every non-DeepSeek chat.
        reasoning_effort=payload.reasoning_effort,
        temporary_mode=payload.temporary_mode,
        expires_at=expires_at,
        workspace_id=workspace_id,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)


async def _build_active_message_payloads(
    conv: Conversation, db: AsyncSession
) -> list[MessageResponse]:
    """Serialize a conversation's *active* thread (Phase 2.6).

    Loads every row once, resolves the active path from
    ``active_leaf_message_id`` (falling back to created_at order for
    legacy conversations), and attaches per-message version metadata so
    the client can render the ``‹ 2/3 ›`` pager. Only messages on the
    active path are returned — inactive sibling subtrees stay in the DB
    but off the wire.
    """
    rows = (
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
    path = active_path(rows, conv.active_leaf_message_id)
    meta = version_meta(rows, path)
    payloads: list[MessageResponse] = []
    for m in path:
        resp = MessageResponse.model_validate(m)
        vm = meta.get(m.id)
        if vm is not None:
            resp.version_index = vm.index
            resp.version_count = vm.count
            resp.sibling_ids = vm.sibling_ids
        payloads.append(resp)
    return payloads


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationDetail:
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    messages = await _build_active_message_payloads(conv, db)
    participants = await load_participants(conv, db)
    return ConversationDetail.model_validate(
        {
            **conv.__dict__,
            "messages": messages,
            "role": role,
            "owner": {
                "user_id": participants.owner.user_id,
                "username": participants.owner.username,
                "email": participants.owner.email,
            },
            "collaborators": [
                {
                    "user_id": c.user_id,
                    "username": c.username,
                    "email": c.email,
                }
                for c in participants.collaborators
            ],
        }
    )


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/activate",
    response_model=ConversationDetail,
)
async def activate_message_version(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationDetail:
    """Switch the visible thread to a sibling version (Phase 2.6).

    ``message_id`` is the sibling the user picked from the ``‹ 2/3 ›``
    pager. We re-point ``active_leaf_message_id`` at the deepest
    most-recent descendant of that sibling so its whole continuation
    comes back into view, then return the freshly-resolved active path.
    """
    conv, role = await get_accessible_conversation(conversation_id, user, db)

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )

    rows = (
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
    conv.active_leaf_message_id = descend_to_leaf(rows, message_id)
    await db.commit()
    await db.refresh(conv)

    messages = await _build_active_message_payloads(conv, db)
    participants = await load_participants(conv, db)
    return ConversationDetail.model_validate(
        {
            **conv.__dict__,
            "messages": messages,
            "role": role,
            "owner": {
                "user_id": participants.owner.user_id,
                "username": participants.owner.username,
                "email": participants.owner.email,
            },
            "collaborators": [
                {
                    "user_id": c.user_id,
                    "username": c.username,
                    "email": c.email,
                }
                for c in participants.collaborators
            ],
        }
    )


@router.patch("/conversations/{conversation_id}", response_model=ConversationSummary)
async def update_conversation(
    conversation_id: uuid.UUID,
    payload: ConversationUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    # Settings (title, pin, model defaults, web-search mode) belong to
    # the conversation owner. A collaborator changing them out from
    # under everyone else would be a footgun; their own toggles live
    # on the user-preference layer instead.
    conv = await _get_owned_conversation(conversation_id, user, db)

    if payload.title is not None:
        conv.title = payload.title
        # User renamed the chat themselves — the server must never overwrite
        # this with an auto-generated title, even on the first stream.
        conv.title_manually_set = True
    if payload.pinned is not None:
        conv.pinned = payload.pinned
    if payload.starred is not None:
        conv.starred = payload.starred
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    if payload.reasoning_effort is not None:
        conv.reasoning_effort = payload.reasoning_effort
    if payload.model_id is not None:
        conv.model_id = payload.model_id
    if payload.provider_id is not None:
        conv.provider_id = payload.provider_id
    # Phase 1 — per-conversation instructions. Honour only when the
    # client explicitly sent the field; an empty / whitespace string
    # clears the steer (stored as NULL), any other value is trimmed
    # and saved.
    if "system_prompt" in payload.model_fields_set:
        cleaned = (payload.system_prompt or "").strip()
        conv.system_prompt = cleaned or None
    if "memory_capture_paused" in payload.model_fields_set and payload.memory_capture_paused is not None:
        conv.memory_capture_paused = payload.memory_capture_paused
    # "Keep this chat" — promote a temporary chat to a permanent one.
    # Only clearing is allowed; we never let a PATCH turn a normal chat
    # temporary (that's a creation-time decision). Dropping the mode also
    # clears the sweeper deadline so the chat can't be auto-deleted.
    if "temporary_mode" in payload.model_fields_set:
        if payload.temporary_mode is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A chat can only be made permanent, not temporary.",
            )
        conv.temporary_mode = None
        conv.expires_at = None
    # Phase P1 — workspace reassignment. Only honour the field when the
    # client explicitly sent it (``model_fields_set`` check) so this
    # PATCH stays idempotent for the common "just toggle pinned"
    # case. Temporary chats can't be workspaced — same reasoning as
    # in :func:`create_conversation`.
    if "workspace_id" in payload.model_fields_set:
        if payload.workspace_id is None:
            conv.workspace_id = None
        else:
            if conv.temporary_mode is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Temporary chats can't belong to a workspace.",
                )
            # Owner or editor may move a chat into the workspace.
            workspace, _wrole = await get_accessible_workspace(
                payload.workspace_id, user, db
            )
            require_workspace_write(_wrole)
            conv.workspace_id = workspace.id

    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)


# --------------------------------------------------------------------
# Branching — fork a conversation from a chosen message
# --------------------------------------------------------------------
@router.post(
    "/conversations/{conversation_id}/branch",
    response_model=ConversationSummary,
    status_code=status.HTTP_201_CREATED,
)
async def branch_conversation(
    conversation_id: uuid.UUID,
    payload: BranchConversationRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Fork an existing conversation from ``message_id``.

    Creates a brand-new conversation owned by the caller and copies
    every message in the source chat that was created at or before
    the fork point. Useful for "explore a different angle" flows
    without losing the original thread, and for collaborators who
    want to take a shared chat private.

    The new chat carries the source's model/provider defaults so
    the next ``send_message`` call uses the familiar setup, and
    records ``parent_conversation_id`` + ``parent_message_id`` so
    the UI can show a "branched from" chip back to the original.

    ACL: caller must be able to *read* the source (owner or
    accepted collaborator). The branch is always owned by the
    caller — nobody can plant a branch in another user's account.
    """
    src, _role = await get_accessible_conversation(conversation_id, user, db)

    fork_msg = await db.get(Message, payload.message_id)
    if fork_msg is None or fork_msg.conversation_id != src.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Fork-point message not found in this conversation.",
        )

    history_q = await db.execute(
        select(Message)
        .where(
            Message.conversation_id == src.id,
            Message.created_at <= fork_msg.created_at,
        )
        .order_by(Message.created_at.asc())
    )
    history = history_q.scalars().all()
    # Defensive — should be impossible since ``fork_msg`` itself
    # would be in the slice — but bail loudly rather than make an
    # empty branch.
    if not history:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Conversation has no messages to branch from.",
        )

    now = datetime.now(timezone.utc)
    base_title = (src.title or "").strip() or fallback_title(history[-1].content)
    # Subchats (``ephemeral``) read as "Subchat: …" and are born temporary;
    # ordinary branches read as "Branch: …" and persist. A subchat is a
    # top-level chat (no ``workspace_id``) because temporary chats can't
    # live in a workspace — the copied history is the context that matters.
    prefix = "Subchat" if payload.ephemeral else "Branch"
    branch_title = f"{prefix}: {base_title}"[:255]

    branch = Conversation(
        user_id=user.id,
        title=branch_title,
        title_manually_set=True,  # don't let the auto-titler stomp it
        model_id=src.model_id,
        provider_id=src.provider_id,
        web_search_mode=src.web_search_mode,
        parent_conversation_id=src.id,
        parent_message_id=fork_msg.id,
        branched_at=now,
        # Ephemeral branch = Subchat: hidden from the sidebar, swept after
        # 24h unless kept. The 24h backstop matches create_conversation's
        # ephemeral path; the frontend also deletes proactively on close.
        temporary_mode="ephemeral" if payload.ephemeral else None,
        expires_at=(now + timedelta(hours=24)) if payload.ephemeral else None,
    )
    db.add(branch)
    await db.flush()  # need branch.id for the message rows

    # Copy each message verbatim. We deliberately preserve metrics
    # (token counts, ttft, cost) so the branch's history matches
    # what the user actually saw when they forked. New turns posted
    # after the fork are billed normally to whoever sends them.
    #
    # Phase 2.6 — rebuild the lineage in the copy: each row's parent is
    # the previously-copied row, and the last copied row becomes the
    # branch's active leaf. ``history`` is already created_at-ordered.
    prev_copy_id: uuid.UUID | None = None
    for src_msg in history:
        copy = Message(
            conversation_id=branch.id,
            role=src_msg.role,
            content=src_msg.content,
            sources=src_msg.sources,
            whiteboard_actions=src_msg.whiteboard_actions,
            attachments=src_msg.attachments,
            parent_id=prev_copy_id,
            prompt_tokens=src_msg.prompt_tokens,
            completion_tokens=src_msg.completion_tokens,
            ttft_ms=src_msg.ttft_ms,
            total_ms=src_msg.total_ms,
            cost_usd_micros=src_msg.cost_usd_micros,
            # Preserve original authorship so the "from Jane" chip
            # in shared chats stays accurate after a private fork.
            author_user_id=src_msg.author_user_id,
            created_at=src_msg.created_at,
        )
        db.add(copy)
        await db.flush()
        prev_copy_id = copy.id

    branch.active_leaf_message_id = prev_copy_id
    await db.commit()
    await db.refresh(branch)

    summary = ConversationSummary.model_validate(branch)
    summary.role = "owner"
    return summary


@router.post(
    "/conversations/{conversation_id}/archive",
    response_model=ConversationSummary,
)
async def archive_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Soft-archive a chat: hide it from the sidebar + global search and
    move it to the Archive page. Idempotent — re-archiving keeps the
    original timestamp. Owner-only (per ``_get_owned_conversation``)."""
    conv = await _get_owned_conversation(conversation_id, user, db)
    if conv.archived_at is None:
        conv.archived_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(conv)
    summary = ConversationSummary.model_validate(conv)
    summary.role = "owner"
    return summary


@router.post(
    "/conversations/{conversation_id}/unarchive",
    response_model=ConversationSummary,
)
async def unarchive_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Restore an archived chat back to the active sidebar list.
    Idempotent — a no-op on a chat that isn't archived."""
    conv = await _get_owned_conversation(conversation_id, user, db)
    if conv.archived_at is not None:
        conv.archived_at = None
        await db.commit()
        await db.refresh(conv)
    summary = ConversationSummary.model_validate(conv)
    summary.role = "owner"
    return summary


@router.delete(
    "/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    # Deletable by the chat's creator, or — for a workspace chat — by the
    # workspace owner, who administers the shared space and must be able to
    # prune any chat in it (a collaborator's chat carries their user_id, so
    # the plain creator check alone locks the owner out of their own
    # workspace). A collaborator still can't delete someone else's chat.
    allowed = conv.user_id == user.id
    if not allowed and conv.workspace_id is not None:
        ws = await db.get(Workspace, conv.workspace_id)
        allowed = ws is not None and ws.user_id == user.id
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    await db.delete(conv)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ====================================================================
# Send message (enqueue stream)
# ====================================================================
async def _enforce_send_quotas(
    request: Request,
    user: User,
    db: AsyncSession,
) -> None:
    """Block a chat-send when the user is rate-limited or over budget.

    Order matters: rate limit first (cheap, IP/key-based) so a runaway
    script eats Redis ops instead of database queries; then the
    budget check (one indexed range scan) for the real-money cap.

    On a budget block we also write an audit row before raising — the
    429 itself is intentionally vague so the user can't probe the
    exact cap by binary-searching message lengths.
    """
    await enforce_user_message_rate(request, user)

    snapshot = await check_budget(db, user)
    if snapshot.verdict != "blocked":
        return

    try:
        await record_event(
            db,
            request=request,
            event_type=EVENT_BUDGET_EXCEEDED,
            user_id=user.id,
            identifier=user.username,
            detail=safe_dict(
                {
                    "window": snapshot.blocking_window,
                    "used": (
                        snapshot.daily_used
                        if snapshot.blocking_window == "daily"
                        else snapshot.monthly_used
                    ),
                    "cap": (
                        snapshot.daily_cap
                        if snapshot.blocking_window == "daily"
                        else snapshot.monthly_cap
                    ),
                }
            ),
        )
        await db.commit()
    except Exception:  # noqa: BLE001 — audit must never break the response
        logger.exception("Failed to record budget_exceeded audit event")

    if snapshot.blocking_window == "daily":
        msg = (
            "You've hit your daily token limit. Your budget resets at "
            "midnight UTC, or ask an admin to raise your daily cap."
        )
    else:
        msg = (
            "You've hit your monthly token limit. The budget resets at "
            "the start of next month, or ask an admin to raise your cap."
        )
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=msg,
    )


def _require_chat_owner(role: str) -> None:
    """Single-owner chats: only the creator may mutate the conversation.

    Workspace collaborators reach a chat through their workspace share
    (``get_accessible_conversation`` hands back ``role="collaborator"``)
    and can *read* the whole thread, but sending / editing / regenerating
    / continuing is reserved for the owner. Keeping chats single-author
    sidesteps the authorship-and-permission tangle of multi-party turns;
    a collaborator who wants to participate starts their own chat in the
    shared workspace. The frontend hides the composer for non-owners, so
    this is the defence-in-depth backstop, not the primary UX.
    """
    if role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This chat is read-only — only its creator can send messages.",
        )


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=SendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def send_message(
    conversation_id: uuid.UUID,
    payload: SendMessageRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SendMessageResponse:
    await _enforce_send_quotas(request, user, db)
    # Single-owner chats: a workspace collaborator can read this thread
    # but only its creator sends into it. ``record_usage`` keys on the
    # sender, so the owner always pays for their own chat.
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    _require_chat_owner(role)

    # Resolve effective model + provider (request overrides conversation default).
    provider_id = payload.provider_id or conv.provider_id
    model_id = payload.model_id or conv.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured. Send provider_id + model_id in the request "
                "or PATCH the conversation with defaults first."
            ),
        )

    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    # Admins may use their own providers + system-wide. Normal users may use
    # any provider owned by an admin + system-wide — never a different
    # non-admin's provider.
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = owner is not None and owner.role == "admin" and user.role != "admin"
        # (Admins fall through here because "not owner_ok" already means the
        # provider belongs to someone else, which admins shouldn't touch.)
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )

    # Custom Models — synthetic ``custom:<uuid>`` ids wrap a real base
    # model. Resolve here so we can enforce the per-user allowlist
    # against the *underlying* base model id (the synthetic id will
    # never be in ``user.allowed_models``). The conversation still
    # stores the synthetic id verbatim so reloading the chat snaps the
    # picker back to the custom model the user originally chose.
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    effective_model_id = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown or disabled custom model",
            )
        effective_model_id = resolved.base_model_id

    # Enforce per-user model allowlist for non-admins. None = unrestricted.
    if user.role != "admin" and user.allowed_models is not None:
        if effective_model_id not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    # Resolve attachments up-front so an unknown ID fails the request loudly
    # instead of silently dropping context on the floor.
    attached_files = await resolve_attachments(db, payload.attachment_ids, user)
    attachment_snapshots = (
        [attachment_snapshot(f) for f in attached_files] if attached_files else None
    )

    # Persist the user message immediately so the client can optimistically
    # render it before the stream opens.
    #
    # Phase 2.6 — link it into the lineage: its parent is whatever leaf
    # was active, and it becomes the new active leaf. The assistant reply
    # streamed in response will then hang off this user message.
    prev_leaf_id = conv.active_leaf_message_id
    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        content=payload.content,
        attachments=attachment_snapshots,
        parent_id=prev_leaf_id,
        # Phase 4b — record who actually sent the turn so the UI can
        # render "from Jane" chips on shared chats.
        author_user_id=user.id,
    )
    db.add(user_msg)
    await db.flush()
    conv.active_leaf_message_id = user_msg.id

    # Set a *provisional* title so the sidebar has something meaningful the
    # moment the POST returns. An AI-generated title will replace it at the
    # end of the stream (see `_stream_generator`). If the user has already
    # renamed the chat we leave their title alone.
    if not conv.title and not conv.title_manually_set:
        conv.title = fallback_title(payload.content)

    # Remember the last-used model on the conversation so subsequent sends
    # work without re-specifying.
    conv.model_id = model_id
    conv.provider_id = provider_id
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    # Same override-then-persist semantics as ``web_search_mode``.
    # ``None`` keeps whatever the conversation already had so the
    # dropdown only writes back when the user actually picks a value.
    if payload.reasoning_effort is not None:
        conv.reasoning_effort = payload.reasoning_effort
    conv.updated_at = datetime.now(timezone.utc)
    # Phase Z1 — slide the 1-hour TTL forward on every send. Ephemeral
    # chats keep their original 24h backstop (the frontend deletes
    # them on navigate-away long before the backstop matters).
    if conv.temporary_mode == "one_hour":
        conv.expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    await db.commit()
    await db.refresh(user_msg)

    # Collaborator activity on a shared chat → ping the owner so
    # they don't miss the new turn while they're elsewhere in the
    # app. Owner sends nothing to themselves. Kept best-effort; a
    # push failure never blocks the stream kicking off.
    if conv.user_id != user.id:
        try:
            from app.notifications import notify_user

            preview = (payload.content or "").strip().replace("\n", " ")
            if len(preview) > 120:
                preview = preview[:117] + "..."
            await notify_user(
                user_id=conv.user_id,
                category="shared_message",
                title=f"New message from {user.username}",
                body=preview or "(empty message)",
                url=f"/chat/{conv.id}",
                tag=f"promptly-shared-{conv.id}",
            )
        except Exception:  # pragma: no cover — push is never critical
            logging.getLogger("promptly.chat.push").warning(
                "push-dispatch-failed", exc_info=True
            )

    effective_mode = (
        payload.web_search_mode
        if payload.web_search_mode is not None
        else (conv.web_search_mode or "off")
    )
    effective_reasoning = (
        payload.reasoning_effort
        if payload.reasoning_effort is not None
        else conv.reasoning_effort
    )
    stream_id = uuid.uuid4()
    ctx: StreamContext = {
        "conversation_id": str(conv.id),
        "user_message_id": str(user_msg.id),
        "provider_id": str(provider_id),
        "model_id": model_id,
        "web_search_mode": effective_mode,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "tools_enabled": bool(payload.tools_enabled),
        # Voice mode (Phase 2): a spoken turn. Only ``SendMessageRequest``
        # carries this; edit/regenerate payloads default to False via
        # getattr. Drives the brevity system-prompt + token backstop.
        "voice": bool(getattr(payload, "voice", False)),
        "reasoning_effort": effective_reasoning,
    }
    await enqueue_stream(stream_id, ctx)

    return SendMessageResponse(
        stream_id=stream_id,
        user_message=MessageResponse.model_validate(user_msg),
    )


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/edit",
    response_model=SendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def edit_and_resend_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: EditMessageRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SendMessageResponse:
    """Rewrite a user message and regenerate the assistant reply.

    Constraints (returned as 4xx, not silently swallowed):

    * ``message_id`` must belong to ``conversation_id``.
    * The message must be a *user* message — editing assistant replies is
      a different feature (regeneration without text change).
    Side effects on success (Phase 2.6 — versioned, non-destructive):

    * A new user message is inserted as a *sibling* of the original
      (same lineage parent), carrying over the original's attachments.
      Nothing is overwritten or deleted — the original turn and every
      reply downstream of it are preserved off the active path and
      reachable via the version pager.
    * The edited turn becomes the active leaf; a fresh stream is enqueued
      against it. The response body matches ``send_message``'s shape, but
      ``user_message`` is the *new* (edited) message, so the frontend
      swaps the old turn out and streams the new reply.
    """
    # Quota gates apply to every regenerate too — otherwise the
    # easiest way around a budget cap is to spam the "edit" button.
    await _enforce_send_quotas(request, user, db)
    # Single-owner chats: only the creator may edit/resend. (The author
    # check further down stays as defence-in-depth for legacy rows.)
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    _require_chat_owner(role)

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    if target.role != "user":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only user messages can be edited.",
        )
    # Author check — only the user who originally sent the message
    # may rewrite it. ``author_user_id`` is backfilled to the
    # conversation owner for legacy rows so single-user chats work
    # exactly as they did before sharing existed.
    author = target.author_user_id or conv.user_id
    if author != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only edit messages you sent.",
        )

    # Phase 2.6 — no "most recent user message" constraint anymore.
    # Editing creates a *sibling* user turn (it does not rewrite or
    # delete anything), so editing an older turn is safe: the previous
    # version and its whole continuation are preserved off the active
    # path and reachable via the version pager.

    # Resolve the effective model + provider for the regeneration.
    # Mirrors send_message: caller may override per-request, otherwise
    # falls back to the conversation default. Same ACL rules apply.
    provider_id = payload.provider_id or conv.provider_id
    model_id = payload.model_id or conv.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured for this conversation. Pick one from "
                "the model selector before retrying."
            ),
        )

    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )

    # Mirror ``send_message``: resolve synthetic ``custom:<uuid>`` ids
    # to their base model id before the allowlist check so non-admins
    # can still regenerate against a custom model they were originally
    # allowed to pick.
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    effective_model_id_for_check = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown or disabled custom model",
            )
        effective_model_id_for_check = resolved.base_model_id

    if user.role != "admin" and user.allowed_models is not None:
        if effective_model_id_for_check not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    # Phase 2.6 — create the edited message as a *sibling* of the
    # original (same lineage parent), carrying over the attachments. The
    # new turn becomes the active leaf; the regenerated assistant reply
    # will hang off it. The original user turn and everything downstream
    # of it stay in the DB, off the active path.
    edited = Message(
        conversation_id=conv.id,
        role="user",
        content=payload.content,
        attachments=target.attachments,
        parent_id=target.parent_id,
        author_user_id=user.id,
    )
    db.add(edited)
    await db.flush()
    conv.active_leaf_message_id = edited.id

    # Update conv defaults so the next plain ``send_message`` works
    # without re-specifying — same behavior as send_message.
    conv.model_id = model_id
    conv.provider_id = provider_id
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    if payload.reasoning_effort is not None:
        conv.reasoning_effort = payload.reasoning_effort
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(edited)

    effective_mode = (
        payload.web_search_mode
        if payload.web_search_mode is not None
        else (conv.web_search_mode or "off")
    )
    effective_reasoning = (
        payload.reasoning_effort
        if payload.reasoning_effort is not None
        else conv.reasoning_effort
    )
    stream_id = uuid.uuid4()
    ctx: StreamContext = {
        "conversation_id": str(conv.id),
        "user_message_id": str(edited.id),
        "provider_id": str(provider_id),
        "model_id": model_id,
        "web_search_mode": effective_mode,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "tools_enabled": bool(payload.tools_enabled),
        # Voice mode (Phase 2): a spoken turn. Only ``SendMessageRequest``
        # carries this; edit/regenerate payloads default to False via
        # getattr. Drives the brevity system-prompt + token backstop.
        "voice": bool(getattr(payload, "voice", False)),
        "reasoning_effort": effective_reasoning,
    }
    await enqueue_stream(stream_id, ctx)

    return SendMessageResponse(
        stream_id=stream_id,
        user_message=MessageResponse.model_validate(edited),
    )


@router.patch(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=MessageResponse,
)
async def patch_assistant_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: PatchAssistantMessageRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    """In-place rewrite of an assistant reply.

    Different from :func:`edit_and_resend_message` (which targets
    user messages and re-streams a fresh reply). This endpoint is
    purely cosmetic — the owner is hand-correcting words the model
    already wrote (typos, scrub stray placeholders, tighten prose)
    without paying tokens for a regeneration.

    Constraints (returned as 4xx, never silent):

    * ``message_id`` must belong to ``conversation_id``.
    * The target message must have ``role == "assistant"``. User
      messages have their own dedicated edit-and-resend flow which
      is the right tool for "I meant to ask something different".
      System messages are managed by the server (compaction
      summaries, project prompts, etc.) and aren't user-editable.
    * Only the conversation **owner** may patch assistant content.
      Letting collaborators rewrite the AI's words on a chat they
      don't own would silently mutate the owner's record. They can
      still edit their own user messages via the existing endpoint.

    Side effects on success:

    * ``messages.content`` is overwritten in place.
    * ``messages.edited_at`` is stamped to NOW so the UI can show
      an "edited" badge.
    * ``messages.sources`` / ``attachments`` / token metrics /
      cost / ``whiteboard_actions`` are intentionally untouched —
      we trust the owner to make the new prose match the metadata
      that's already there. (If they edit out a quoted citation
      the source list will look orphaned, which is fine.)
    """
    # No quota debit and no need for the heavier streaming
    # ``get_accessible_conversation`` walk — owner-only is the
    # entire ACL.
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        # 404 instead of 403 to avoid leaking the existence of a
        # conversation the caller can't see.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    if target.role != "assistant":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Only assistant messages can be patched in place. Use "
                "/edit on user messages."
            ),
        )

    new_content = payload.content.strip()
    if not new_content:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Content can't be empty.",
        )
    # No-op fast-path so a stray re-save with identical text doesn't
    # bump the edited_at stamp.
    if new_content == (target.content or ""):
        return MessageResponse.model_validate(target)

    target.content = new_content
    target.edited_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(target)
    return MessageResponse.model_validate(target)


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete a single message.

    Owner-only, and deletes exactly the targeted row — unlike the
    edit/regenerate flows which also drop everything after their
    target. We intentionally keep this surgical: removing one message
    (e.g. a bad assistant reply, or a question the user no longer wants
    in the transcript) shouldn't cascade and wipe later turns. The
    caller is trusted to delete what they mean to; an orphaned
    user/assistant pair is a valid (if lopsided) transcript.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )

    # Phase 2.6 — re-link the lineage before deleting so children aren't
    # orphaned (the FK is ``SET NULL``, which would sever the active-path
    # walk). Splice them onto the deleted row's parent, and slide the
    # active leaf back if it pointed at this row.
    await db.execute(
        update(Message)
        .where(Message.parent_id == target.id)
        .values(parent_id=target.parent_id)
    )
    if conv.active_leaf_message_id == target.id:
        conv.active_leaf_message_id = target.parent_id

    await db.delete(target)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/conversations/{conversation_id}/messages/{message_id}/feedback",
    response_model=MessageResponse,
)
async def set_message_feedback(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: MessageFeedbackRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    """Rate an assistant reply thumbs up / down (Phase 2.5).

    Owner-only and assistant-rows-only. ``rating=None`` clears the
    rating (toggling a thumb off) and also drops any stored reason.
    The reason is a short optional note typically captured on a
    thumbs-down; we keep it only alongside a ``"down"`` rating.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    if target.role != "assistant":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only assistant replies can be rated.",
        )

    target.feedback = payload.rating
    # Reason only makes sense attached to a rating; clear it when the
    # rating is cleared or when none was supplied.
    if payload.rating is None:
        target.feedback_reason = None
    else:
        reason = (payload.reason or "").strip()
        target.feedback_reason = reason or None
    await db.commit()
    await db.refresh(target)
    return MessageResponse.model_validate(target)


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/regenerate",
    response_model=SendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def regenerate_assistant_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: RegenerateMessageRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SendMessageResponse:
    """Re-stream an assistant reply without rewriting the user message.

    Constraints (returned as 4xx):

    * ``message_id`` must be an *assistant* message in this conversation.
    * Its lineage parent must be a user message; regenerating an
      assistant message with no prompt would just re-emit the system
      preamble.

    Side effects on success (Phase 2.6 — versioned, non-destructive):

    * Nothing is deleted. The fresh answer streams in as a *sibling* of
      the target (both share the user prompt as their ``parent_id``), so
      the previous answer — and any conversation that branched off it —
      is preserved off the active path and reachable via the version
      pager.
    * The active leaf is moved back to the prompt for the in-flight
      regeneration, then to the new assistant reply once it completes.
    * A fresh stream is enqueued against the prompt. Callers may override
      ``provider_id`` / ``model_id`` to power the "try a different model"
      button; omitting them regenerates with the conversation's defaults.

    The response shape matches ``send_message`` and ``edit_and_resend``
    so the frontend streaming hook stays unchanged — we just hand back
    the *preceding user message* in ``user_message`` because that's what
    the stream is being driven from.
    """
    # Same quota treatment as edit — otherwise "regenerate" becomes a
    # budget escape hatch.
    await _enforce_send_quotas(request, user, db)
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    _require_chat_owner(role)

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    if target.role != "assistant":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only assistant messages can be regenerated.",
        )

    # Phase 2.6 — the prompt is simply this reply's lineage parent. We no
    # longer require it to be the most-recent assistant: regenerating
    # produces a *sibling* answer rather than destroying anything, so an
    # older turn can be regenerated safely (its previous continuation is
    # preserved off the active path).
    prompt = await db.get(Message, target.parent_id) if target.parent_id else None
    if prompt is None or prompt.role != "user":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No user prompt precedes this assistant message.",
        )

    # Resolve model/provider — identical rules to edit_and_resend_message.
    # The common case is "no body at all, reuse defaults", so the happy
    # path doesn't even touch the provider lookup branch.
    provider_id = payload.provider_id or conv.provider_id
    model_id = payload.model_id or conv.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured for this conversation. Pick one from "
                "the model selector before retrying."
            ),
        )

    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )

    # Resolve ``custom:<uuid>`` to the underlying base model id for
    # the allowlist check. See :func:`send_message` for the full
    # rationale — in short: the synthetic id will never be in
    # ``user.allowed_models`` but the base one is.
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    effective_model_id_for_check = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown or disabled custom model",
            )
        effective_model_id_for_check = resolved.base_model_id

    if user.role != "admin" and user.allowed_models is not None:
        if effective_model_id_for_check not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    # Phase 2.6 — no deletes. The new answer streams in as a *sibling* of
    # ``target`` (both hang off ``prompt``). We re-point the active leaf
    # back to the prompt so the in-flight regeneration renders in place;
    # the streamed assistant becomes the new leaf when it finishes.
    conv.active_leaf_message_id = prompt.id

    # Persist any model override onto the conversation so the next plain
    # send picks up the choice, mirroring send_message/edit semantics.
    conv.model_id = model_id
    conv.provider_id = provider_id
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    if payload.reasoning_effort is not None:
        conv.reasoning_effort = payload.reasoning_effort
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(prompt)

    effective_mode = (
        payload.web_search_mode
        if payload.web_search_mode is not None
        else (conv.web_search_mode or "off")
    )
    effective_reasoning = (
        payload.reasoning_effort
        if payload.reasoning_effort is not None
        else conv.reasoning_effort
    )
    stream_id = uuid.uuid4()
    ctx: StreamContext = {
        "conversation_id": str(conv.id),
        "user_message_id": str(prompt.id),
        "provider_id": str(provider_id),
        "model_id": model_id,
        "web_search_mode": effective_mode,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "tools_enabled": bool(payload.tools_enabled),
        # Voice mode (Phase 2): a spoken turn. Only ``SendMessageRequest``
        # carries this; edit/regenerate payloads default to False via
        # getattr. Drives the brevity system-prompt + token backstop.
        "voice": bool(getattr(payload, "voice", False)),
        "reasoning_effort": effective_reasoning,
    }
    await enqueue_stream(stream_id, ctx)

    return SendMessageResponse(
        stream_id=stream_id,
        user_message=MessageResponse.model_validate(prompt),
    )


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/continue",
    response_model=SendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def continue_assistant_message(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: RegenerateMessageRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SendMessageResponse:
    """Resume a *truncated* assistant reply, appending to the same bubble.

    Unlike regenerate (which produces a fresh sibling answer), continue
    keeps the existing reply and streams more text onto the end of it.
    The generator splices the partial answer into the prompt as context
    and writes the continuation back onto this message row.

    Constraints (returned as 4xx):

    * ``message_id`` must be an *assistant* message in this conversation.
    * It must be the conversation's current active leaf — we only ever
      continue the reply the user is actually looking at, never an older
      off-path version.
    * Its lineage parent must be a user message.
    """
    await _enforce_send_quotas(request, user, db)
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    _require_chat_owner(role)

    target = await db.get(Message, message_id)
    if target is None or target.conversation_id != conv.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    if target.role != "assistant":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only assistant messages can be continued.",
        )
    if conv.active_leaf_message_id != target.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only the latest reply on the active path can be continued.",
        )

    prompt = await db.get(Message, target.parent_id) if target.parent_id else None
    if prompt is None or prompt.role != "user":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No user prompt precedes this assistant message.",
        )

    # Reuse the conversation's configured model/provider; allow the same
    # optional overrides regenerate supports (kept for symmetry, rarely
    # used for a continuation).
    provider_id = payload.provider_id or conv.provider_id
    model_id = payload.model_id or conv.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured for this conversation. Pick one from "
                "the model selector before retrying."
            ),
        )

    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )

    # ``custom:<uuid>`` → base model id for the allowlist check (see
    # send_message / regenerate for the full rationale).
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    effective_model_id_for_check = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown or disabled custom model",
            )
        effective_model_id_for_check = resolved.base_model_id

    if user.role != "admin" and user.allowed_models is not None:
        if effective_model_id_for_check not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    # The active leaf stays on ``target`` — we're extending it in place.
    conv.model_id = model_id
    conv.provider_id = provider_id
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    if payload.reasoning_effort is not None:
        conv.reasoning_effort = payload.reasoning_effort
    conv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(prompt)

    effective_mode = (
        payload.web_search_mode
        if payload.web_search_mode is not None
        else (conv.web_search_mode or "off")
    )
    effective_reasoning = (
        payload.reasoning_effort
        if payload.reasoning_effort is not None
        else conv.reasoning_effort
    )
    stream_id = uuid.uuid4()
    ctx: StreamContext = {
        "conversation_id": str(conv.id),
        "user_message_id": str(prompt.id),
        "provider_id": str(provider_id),
        "model_id": model_id,
        "web_search_mode": effective_mode,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "tools_enabled": bool(payload.tools_enabled),
        # Voice mode (Phase 2): a spoken turn. Only ``SendMessageRequest``
        # carries this; edit/regenerate payloads default to False via
        # getattr. Drives the brevity system-prompt + token backstop.
        "voice": bool(getattr(payload, "voice", False)),
        "reasoning_effort": effective_reasoning,
        "continue_from_message_id": str(target.id),
    }
    await enqueue_stream(stream_id, ctx)

    return SendMessageResponse(
        stream_id=stream_id,
        user_message=MessageResponse.model_validate(prompt),
    )


@router.post("/enhance-prompt", response_model=EnhancePromptResponse)
async def enhance_prompt_endpoint(
    payload: EnhancePromptRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EnhancePromptResponse:
    """Rewrite a rough composer draft into a sharper prompt (Phase 3.2).

    Stateless — no conversation, nothing persisted. Uses the caller's
    selected model (or any model they're allowed to use). Quota-checked
    like a send so it can't be abused as a free generation backdoor.
    """
    from app.chat.enhance import enhance_prompt
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    await _enforce_send_quotas(request, user, db)

    provider_id = payload.provider_id
    model_id = payload.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pick a model before enhancing a prompt.",
        )

    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )

    effective_model_id = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown or disabled custom model",
            )
        provider = resolved.base_provider
        effective_model_id = resolved.base_model_id

    if user.role != "admin" and user.allowed_models is not None:
        if effective_model_id not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    try:
        improved = await enhance_prompt(
            text=payload.text,
            provider=provider,
            model_id=effective_model_id,
        )
    except ProviderError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Prompt enhancement failed: {e}",
        ) from e

    return EnhancePromptResponse(enhanced=improved)


@router.post("/edit-artifact", response_model=ArtifactEditResponse)
async def edit_artifact_endpoint(
    payload: ArtifactEditRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactEditResponse:
    """Apply a natural-language change to a code artifact (Phase 5).

    Stateless — no conversation, nothing persisted. The side panel sends
    the current artifact source + a one-line change request and gets the
    full updated source back, which it swaps into the draft in place.
    Quota-checked and model-gated exactly like ``enhance-prompt``.
    """
    from app.chat.artifact_edit import edit_artifact
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    await _enforce_send_quotas(request, user, db)

    provider_id = payload.provider_id
    model_id = payload.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pick a model before editing an artifact.",
        )

    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )

    effective_model_id = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown or disabled custom model",
            )
        provider = resolved.base_provider
        effective_model_id = resolved.base_model_id

    if user.role != "admin" and user.allowed_models is not None:
        if effective_model_id not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    try:
        updated = await edit_artifact(
            source=payload.source,
            language=payload.language,
            instruction=payload.instruction,
            provider=provider,
            model_id=effective_model_id,
        )
    except ProviderError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Artifact edit failed: {e}",
        ) from e

    return ArtifactEditResponse(updated=updated)


@router.post(
    "/conversations/{conversation_id}/compact",
    response_model=CompactionResponse,
)
async def compact_conversation_endpoint(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompactionResponse:
    """Compact the middle of a conversation to reclaim context space.

    Keeps the first few and last several messages intact, asks the
    conversation's current model to summarise everything in between,
    and replaces those middle rows with a single ``role='system'``
    summary tagged so the UI renders it as a "Compacted summary"
    chip.

    Only the conversation owner may compact — collaborators working
    on a shared chat shouldn't be able to destructively reshape
    history the owner didn't request.

    Returns 4xx when there's nothing to compact (chat is too short),
    502 when the provider call fails (no rows are touched in that
    case — a half-applied compaction would corrupt the timeline).
    """
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    if role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the conversation owner can compact this chat.",
        )

    if not conv.provider_id or not conv.model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured for this conversation. Send at "
                "least one message first so a default is persisted."
            ),
        )

    provider = await db.get(ModelProvider, conv.provider_id)
    if provider is None or not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This conversation's provider is unavailable.",
        )

    try:
        result = await compact_conversation(
            conversation=conv,
            llm_provider=provider,
            llm_model_id=conv.model_id,
            db=db,
        )
    except CompactionError as e:
        # Domain errors — too-short history, empty summary, provider
        # failure that we caught upstream. Return 400 for "can't
        # compact yet", 502 for "tried and the provider refused".
        msg = str(e)
        if "enough history" in msg or "too short" in msg or "no textual" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=msg
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=msg
        )

    return CompactionResponse(
        messages_removed=result.messages_removed,
        summary_message_id=uuid.UUID(result.summary_message_id),
    )


@router.post(
    "/conversations/{conversation_id}/summarise-to-workspace",
    response_model=SummariseToWorkspaceResponse,
)
async def summarise_to_workspace_endpoint(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SummariseToWorkspaceResponse:
    """Generate a Markdown summary of the chat and pin it to its workspace.

    Writes the summary as a new file in the user's Generated folder,
    then pins it to the conversation's parent workspace so every other
    chat in the workspace picks it up on the next turn (via the
    existing workspace-file injection pipeline — no new wiring).

    Preconditions:

    * Caller must be the conversation owner. Collaborators can't
      mutate the workspace's pinned-file set indirectly.
    * Conversation must live inside a workspace (``workspace_id`` set).
      If the user wants to pin the summary but the chat is
      standalone, they first need to move it into a workspace.
    * Conversation must have a provider + model configured
      (matches compaction — we need something to call).
    * At least 4 textual turns — see :mod:`app.chat.summariser`
      for the threshold.

    Errors:

    * 400 for "not in a workspace", "chat too short", "no provider".
    * 403 if the caller isn't the owner.
    * 502 if the LLM call fails (no file is written in that case).
    """
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    if role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the conversation owner can save a summary to the workspace.",
        )

    if conv.workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This chat isn't in a workspace yet. Move it into one "
                "first — then the summary will be visible to every "
                "other chat in that workspace."
            ),
        )

    workspace = await db.get(Workspace, conv.workspace_id)
    if workspace is None or workspace.user_id != user.id:
        # Shouldn't normally happen — workspace_id is owner-scoped in
        # the move-to-workspace path — but guard in case a race left
        # the conversation pointing at a deleted workspace.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Parent workspace not found.",
        )

    if not conv.provider_id or not conv.model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured for this conversation. Send at "
                "least one message first so a default is persisted."
            ),
        )

    provider = await db.get(ModelProvider, conv.provider_id)
    if provider is None or not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This conversation's provider is unavailable.",
        )

    try:
        summary_md = await summarise_conversation_to_markdown(
            conversation=conv,
            llm_provider=provider,
            llm_model_id=conv.model_id,
            db=db,
        )
    except SummariseError as e:
        msg = str(e)
        if "too short" in msg or "no textual" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=msg
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=msg
        )

    # Pretty filename built from the conversation title so it reads
    # well in the workspace's file list. We don't have a rich title-
    # sanitiser on the backend; a minimal strip here is enough for a
    # filesystem-friendly name (``persist_generated_file`` doesn't
    # touch the stored filename, it just uses the extension).
    raw_title = (conv.title or "Untitled chat").strip() or "Untitled chat"
    safe_title = "".join(
        ch if ch.isalnum() or ch in (" ", "-", "_") else "-"
        for ch in raw_title
    ).strip()[:80] or "chat"
    filename = f"Summary — {safe_title}.md"

    body = (
        f"# Summary: {raw_title}\n\n"
        f"_Generated from conversation `{conv.id}` on save — "
        f"regenerate anytime from the chat header._\n\n"
        f"{summary_md}\n"
    )
    try:
        uf = await persist_generated_file(
            db,
            user=user,
            filename=filename,
            mime_type="text/markdown",
            content=body.encode("utf-8"),
            source_kind="chat_summary",
        )
    except GeneratedFileError as e:
        # Usually quota — give the user the message directly; the
        # storage / billing UX already explains how to resolve it.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    # Auto-pin to the workspace. Idempotent: if we somehow ran twice
    # with the same file id (we don't — persist_generated_file
    # always mints a fresh UUID) the unique (workspace, file) row
    # would be swallowed by the existing_q check.
    existing_q = await db.execute(
        select(WorkspaceFile).where(
            WorkspaceFile.workspace_id == workspace.id,
            WorkspaceFile.file_id == uf.id,
        )
    )
    if existing_q.scalar_one_or_none() is None:
        db.add(WorkspaceFile(workspace_id=workspace.id, file_id=uf.id))
        workspace.updated_at = datetime.now(timezone.utc)
        await db.commit()

    logger.info(
        "Summarised conversation %s -> file %s, pinned to workspace %s",
        conv.id,
        uf.id,
        workspace.id,
    )

    return SummariseToWorkspaceResponse(
        file_id=uf.id,
        filename=uf.filename,
        workspace_id=workspace.id,
        workspace_title=workspace.title,
        chars=len(summary_md),
    )


# ====================================================================
# SSE stream
# ====================================================================
def _sse(data: dict) -> str:
    """Format a dict as a single SSE `data:` event."""
    return f"data: {json.dumps(data)}\n\n"


def _classify_upstream_error(
    message: str,
    *,
    provider_type: str,
    status_code: int | None = None,
    retry_after: float | None = None,
) -> dict[str, Any] | None:
    """Classify a ``ProviderError`` message into a structured error.

    Returns ``None`` for unclassified errors (caller renders the raw
    message as before). A non-None return is a dict of extra SSE
    fields — ``error_code`` + optional ``error_help_url`` +
    ``error_title`` (+ ``retry_after`` for rate limits) — that the
    frontend uses to pick a richer error card (links, buttons, retry
    countdown, tone) instead of the default red banner.

    Classification prefers the upstream HTTP ``status_code`` when we have
    it (reliable) and falls back to distinctive message fragments for
    transport errors that carry no status (timeouts, connection drops).

    Kept in the chat router rather than in ``provider.py`` because
    the classification is a *UX* concern (how do we want to talk to
    the user about this?), not a provider-abstraction concern. If we
    ever add more providers with their own distinctive auth/policy
    errors, new branches land here.
    """
    lowered = message.lower()

    # OpenRouter's guardrail / privacy filter — fires when every
    # endpoint for the requested model is excluded by the account's
    # privacy settings (no-training, ZDR, etc). The exact phrase
    # OR returns has been stable for a while but we match on the
    # distinctive fragments in case the suffix changes.
    if provider_type == "openrouter" and (
        "no endpoints available matching your guardrail" in lowered
        or ("privacy" in lowered and "no endpoints" in lowered)
        or ("data policy" in lowered and "no endpoints" in lowered)
    ):
        return {
            "error_code": "openrouter_privacy_blocked",
            "error_title": "This model isn't allowed by your OpenRouter privacy settings",
            "error_help_url": "https://openrouter.ai/settings/privacy",
        }

    # Provider-agnostic catch: the image attachment didn't decode. We
    # already transcode non-universal formats and drop truncated files
    # before shipping, but flaky mobile uploads can still produce bytes
    # the provider rejects. Give the user a clearer nudge than the raw
    # ``Invalid image data-url`` string Google returns.
    if (
        "invalid image data-url" in lowered
        or "invalid image data url" in lowered
        or ("invalid image" in lowered and "data" in lowered and "url" in lowered)
    ):
        return {
            "error_code": "invalid_image_attachment",
            "error_title": "One of your image attachments couldn't be read",
            "error_help_url": None,
        }

    # --- Generic, provider-agnostic classes (status-code first) --------
    # Rate limited. Pass the retry countdown through when the provider
    # told us how long to wait so the card can tick it down.
    if (
        status_code == 429
        or "rate limit" in lowered
        or "too many requests" in lowered
        or "quota" in lowered
    ):
        out: dict[str, Any] = {
            "error_code": "rate_limited",
            "error_title": "Rate limited by the model provider",
            "error_help_url": None,
        }
        if retry_after and retry_after > 0:
            # Clamp to something sane — a stray header shouldn't strand
            # the user behind a multi-hour countdown.
            out["retry_after"] = min(float(retry_after), 300.0)
        return out

    # Auth / bad key. 401 (unauthorized) or 403 (forbidden) — by this
    # point the OpenRouter-privacy 403 has already been matched above.
    if (
        status_code in (401, 403)
        or "unauthorized" in lowered
        or "authentication" in lowered
        or ("api key" in lowered and (
            "invalid" in lowered or "incorrect" in lowered or "no api key" in lowered
        ))
    ):
        return {
            "error_code": "auth_failed",
            "error_title": "The provider rejected the API key",
            "error_help_url": None,
        }

    # Provider overloaded / transient host hiccup — any 5xx, plus the
    # distinctive capacity/engine strings (e.g. DeepInfra's "EngineCore
    # encountered an issue") and bare transport failures that carry no
    # status code at all.
    if (
        (status_code is not None and status_code >= 500)
        or "overloaded" in lowered
        or "capacity" in lowered
        or "enginecore" in lowered
        or "engine core" in lowered
        or "service unavailable" in lowered
        or "temporarily unavailable" in lowered
        or "bad gateway" in lowered
        or "gateway timeout" in lowered
        or "timed out" in lowered
        or "timeout" in lowered
        or "connection error" in lowered
        or "connection reset" in lowered
    ):
        return {
            "error_code": "provider_overloaded",
            "error_title": "The model host hiccuped",
            "error_help_url": None,
        }

    return None


# Some providers occasionally stream a tool call as literal XML text in the
# content channel instead of as a structured tool_call (a known failure
# mode where the OpenAI-compat layer doesn't parse the model's native
# function-call syntax — e.g. a model that emits Anthropic-style
# ``<tool_calls><invoke name="web_search">…</invoke></tool_calls>`` markup).
# Left untouched, that markup gets persisted + rendered as the assistant's
# reply (a wall of broken XML instead of an answer). We strip it at the
# persistence boundary; when stripping empties a reply that *did* run tools,
# the synthesis-retry net regenerates a real answer from what was gathered.
_LEAKED_TOOL_XML_RES: tuple[re.Pattern[str], ...] = (
    # Whole ``<tool_calls>…</tool_calls>`` block (closed or cut off at EOS).
    re.compile(
        r"<\s*tool_calls\s*>.*?(?:</\s*tool_calls\s*>|$)",
        re.DOTALL | re.IGNORECASE,
    ),
    # Stray ``<invoke name=…>…</invoke>`` block with no wrapper.
    re.compile(
        r"<\s*invoke\b[^>]*>.*?(?:</\s*invoke\s*>|$)",
        re.DOTALL | re.IGNORECASE,
    ),
)


def _strip_leaked_tool_call_xml(text: str) -> str:
    """Remove leaked tool-call XML from streamed assistant content.

    Cheap no-op on the overwhelmingly common case (content with no ``<``).
    """
    if not text or "<" not in text:
        return text
    cleaned = text
    for rx in _LEAKED_TOOL_XML_RES:
        cleaned = rx.sub("", cleaned)
    return cleaned.strip()


def _dedupe_sources(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Final dedup pass on the per-stream sources accumulator.

    Multiple search / fetch tool calls in the same turn can pull the
    same URL — e.g. the model searches twice and both hit Wikipedia,
    or it fetches the URL it already cited from a search result. We
    canonicalise (lowercase host, drop www, strip tracking params)
    and keep the first occurrence so the sources list mirrors the
    citation numbers the model actually used in its reply.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url") or "")
        if not url:
            continue
        key = canonicalise_url(url) or url
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _model_supports_vision(provider: ModelProvider, model_id: str) -> bool:
    """Look up ``supports_vision`` on the provider's cached catalog row.

    Returns False when the model isn't in the catalog (admin curated it
    out, or the catalog hasn't been refreshed since this model appeared).
    Defaulting closed avoids 400-ing the provider with image content for
    a text-only model.
    """
    for row in provider.models or []:
        if isinstance(row, dict) and row.get("id") == model_id:
            return bool(row.get("supports_vision", False))
    return False


async def _load_message_attachments(
    db: AsyncSession,
    history_rows: list[Message],
    user: User,
) -> dict[uuid.UUID, list[UserFile]]:
    """Resolve every attachment referenced by every message in ``history_rows``.

    Returns ``{message_id: [UserFile, ...]}`` preserving the original attach
    order per message. Attachments the user can no longer see (file
    deleted, or owned by another non-admin user) are silently dropped —
    the textual snapshot persisted on ``messages.attachments`` keeps the
    UI rendering them as chips, but the model only ever sees what the
    user is actually authorised for *right now*.
    """
    # First pass: collect every attachment id we might need to load.
    wanted: list[uuid.UUID] = []
    for m in history_rows:
        if not m.attachments:
            continue
        for entry in m.attachments:
            raw = entry.get("id") if isinstance(entry, dict) else None
            if not raw:
                continue
            try:
                wanted.append(uuid.UUID(raw))
            except (ValueError, TypeError):
                continue

    if not wanted:
        return {}

    rows = (
        (
            await db.execute(
                select(UserFile).where(UserFile.id.in_(wanted))
            )
        )
        .scalars()
        .all()
    )
    by_id = {r.id: r for r in rows}

    out: dict[uuid.UUID, list[UserFile]] = {}
    for m in history_rows:
        if not m.attachments:
            continue
        ordered: list[UserFile] = []
        for entry in m.attachments:
            raw = entry.get("id") if isinstance(entry, dict) else None
            if not raw:
                continue
            try:
                fid = uuid.UUID(raw)
            except (ValueError, TypeError):
                continue
            row = by_id.get(fid)
            if row is None:
                continue
            # ACL: shared files (user_id is None) are always readable;
            # private files must belong to this user.
            if row.user_id is not None and row.user_id != user.id:
                continue
            ordered.append(row)
        if ordered:
            out[m.id] = ordered
    return out


# Hard ceiling on the number of model<->tool round-trips we'll do for a
# single user turn. Each hop is one full streaming call against the
# provider, so an unbounded loop is *expensive* — both in tokens and in
# wall-clock time.
#
# Sized at 8 since the previous cap of 5 fell over on image-research
# turns where the model legitimately wanted to chain ~5 searches
# (e.g. "what game is this screenshot from?" → identify motif →
# verify name → cross-check details → confirm). The cap is a defence
# against *unbounded* loops, not a constraint on legitimate
# exploration, so a few extra hops are well worth the predictable
# cost.
#
# The *last* hop is run with ``tools=None`` (forced finish) so the
# model has no escape hatch to keep calling tools forever — it has to
# emit text, synthesising from whatever it has already gathered. That
# converts the historical "abort with red error chip + empty assistant
# bubble" failure mode into a normal best-effort reply. The
# error-chip path stays in place for the pathological case where the
# model produces neither text nor tool-calls on the forced hop.
MAX_TOOL_HOPS = 8

# Token backstop for voice-mode turns when the client didn't set its own
# cap. The brevity system prompt does the real work (replies end
# naturally); this is just a guard so a model that ignores the steer
# can't read a 1,000-word essay aloud. Generous enough that a normal
# 2–4 sentence spoken reply is never truncated mid-word.
VOICE_MAX_TOKENS = 400


def _build_tool_calls_payload(
    pending: dict[int, dict[str, str]],
) -> list[dict[str, Any]]:
    """Turn the per-index merge buffer into OpenAI's ``tool_calls`` shape.

    Sorted by index so the assistant message we append matches what the
    provider streamed (some providers cache on order). Skips any slot
    that's missing an id or name — those are deltas the model never
    finished, and re-feeding a half-formed call back to the provider
    causes 400s rather than graceful degradation.
    """
    out: list[dict[str, Any]] = []
    for idx in sorted(pending.keys()):
        slot = pending[idx]
        if not slot.get("id") or not slot.get("name"):
            continue
        out.append(
            {
                "id": slot["id"],
                "type": "function",
                "function": {
                    "name": slot["name"],
                    "arguments": slot.get("arguments", ""),
                },
            }
        )
    return out


async def _audit_tool_event(
    db: AsyncSession,
    *,
    request: Request,
    user: User,
    event_type: str,
    tool_name: str,
    detail: dict[str, Any] | None = None,
) -> None:
    """Best-effort audit row for a tool dispatch.

    Wrapped in a broad except so an audit failure can never tear down
    the SSE stream. We commit immediately so the row is durable before
    the assistant message lands — keeps the trail intact even if the
    surrounding turn errors out partway through.
    """
    try:
        payload: dict[str, Any] = {"tool": tool_name}
        if detail:
            payload.update(detail)
        await record_event(
            db,
            request=request,
            event_type=event_type,
            user_id=user.id,
            identifier=user.username,
            detail=safe_dict(payload),
        )
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to record %s audit event", event_type)


async def _dispatch_tools(
    *,
    db: AsyncSession,
    request: Request,
    user: User,
    pending_calls: dict[int, dict[str, str]],
    ctx: ToolContext,
    sse_yield,  # noqa: ANN001 — callable: dict -> pre-formatted SSE string
    on_attachment,  # noqa: ANN001 — callable: snapshot dict -> None
    on_sources=None,  # noqa: ANN001 — callable: list[dict] -> None | None
    on_cost=None,  # noqa: ANN001 — callable: float -> None | None
    invocation_counts: dict[str, int] | None = None,
    per_tool_caps: dict[str, int] | None = None,
) -> AsyncGenerator[
    tuple[str, dict[str, Any] | None], None
]:
    """Execute every pending tool call sequentially.

    Yields ``(sse_event_string, history_message_or_None)`` tuples. The
    caller forwards the SSE string to the client; if ``history_message``
    is non-None it appends it to the running conversation so the next
    model hop sees the result. ``None`` is used for the ``tool_started``
    pre-event, which has no equivalent in the OpenAI conversation
    schema — only ``tool`` rows belong in history.

    Sequential rather than concurrent for two reasons:

    * Tools share the chat router's ``AsyncSession``; concurrent writes
      on a single AsyncSession are unsafe.
    * Preserving call order makes the audit log + the UI reflect the
      model's intent. Concurrency wouldn't buy much for Phase A1's
      tool shapes (every one is sub-second).
    """
    for idx in sorted(pending_calls.keys()):
        slot = pending_calls[idx]
        call_id = slot.get("id") or ""
        name = slot.get("name") or ""
        raw_args = slot.get("arguments") or "{}"

        if not call_id or not name:
            # Half-formed call (model emitted deltas but no id/name) —
            # silently drop. We can't add a tool result without an id,
            # and the assistant turn we appended doesn't reference
            # this index either, so the conversation stays consistent.
            continue

        # 1) "started" pre-event so the UI can render a pending block
        #    before the tool completes. No history message — the
        #    assistant turn carrying the call was appended by the
        #    caller already.
        yield (
            sse_yield({"event": "tool_started", "id": call_id, "name": name}),
            None,
        )

        tool = get_tool(name)
        if tool is None:
            err_msg = f"Unknown tool: {name!r}"
            await _audit_tool_event(
                db,
                request=request,
                user=user,
                event_type=EVENT_TOOL_FAILED,
                tool_name=name,
                detail={"error": "unknown_tool"},
            )
            yield (
                sse_yield(
                    {
                        "event": "tool_finished",
                        "id": call_id,
                        "name": name,
                        "ok": False,
                        "error": err_msg,
                    }
                ),
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": err_msg,
                },
            )
            continue

        # 2) Parse arguments. Bad JSON is a controlled failure — feed
        #    the error back to the model so it can retry with a fix.
        try:
            args = json.loads(raw_args) if raw_args.strip() else {}
            if not isinstance(args, dict):
                raise TypeError("tool arguments must be a JSON object")
        except (json.JSONDecodeError, TypeError) as e:
            err_msg = f"Invalid tool arguments: {e}"
            await _audit_tool_event(
                db,
                request=request,
                user=user,
                event_type=EVENT_TOOL_FAILED,
                tool_name=name,
                detail={"error": "bad_arguments"},
            )
            yield (
                sse_yield(
                    {
                        "event": "tool_finished",
                        "id": call_id,
                        "name": name,
                        "ok": False,
                        "error": err_msg,
                    }
                ),
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": err_msg,
                },
            )
            continue

        # 3) Per-turn cap (e.g. ``web_search`` budget, ``generate_image``
        #    budget). Counted before the call so a refusal still bumps
        #    the counter — the model can't get around the cap by spamming
        #    retries. ``per_tool_caps`` overrides the tool-class default
        #    (used by the chat stream to honour the admin-configured
        #    ``chat_max_web_searches_per_turn``); falls back to the
        #    static ``Tool.max_per_turn`` attribute when no override is
        #    in scope.
        effective_cap: int | None = None
        if per_tool_caps is not None and name in per_tool_caps:
            effective_cap = per_tool_caps[name]
        elif tool.max_per_turn is not None:
            effective_cap = tool.max_per_turn
        if effective_cap is not None and invocation_counts is not None:
            spent = invocation_counts.get(name, 0)
            if spent >= effective_cap:
                err_msg = (
                    f"Tool '{name}' is limited to {effective_cap} "
                    "call(s) per turn. Ask the user to send another "
                    "message if more are needed."
                )
                await _audit_tool_event(
                    db,
                    request=request,
                    user=user,
                    event_type=EVENT_TOOL_FAILED,
                    tool_name=name,
                    detail={"error": "per_turn_cap"},
                )
                # ``error_kind`` lets the frontend recognise this as a
                # benign overshoot rather than a real provider failure
                # — the consolidation rule in MessageBubble uses it to
                # suppress these chips when at least one call of the
                # same tool already succeeded this turn.
                yield (
                    sse_yield(
                        {
                            "event": "tool_finished",
                            "id": call_id,
                            "name": name,
                            "ok": False,
                            "error": err_msg,
                            "error_kind": "per_turn_cap",
                        }
                    ),
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": err_msg,
                    },
                )
                continue
            invocation_counts[name] = spent + 1

        # 4) Run the tool.
        try:
            result = await tool.run(ctx, args)
        except ToolError as e:
            err_msg = str(e)
            await _audit_tool_event(
                db,
                request=request,
                user=user,
                event_type=EVENT_TOOL_FAILED,
                tool_name=name,
                detail={"error": "tool_error"},
            )
            yield (
                sse_yield(
                    {
                        "event": "tool_finished",
                        "id": call_id,
                        "name": name,
                        "ok": False,
                        "error": err_msg,
                    }
                ),
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": f"Error: {err_msg}",
                },
            )
            continue
        except Exception as e:  # noqa: BLE001 — uncaught tool bug
            logger.exception("Tool %s raised unexpectedly", name)
            await _audit_tool_event(
                db,
                request=request,
                user=user,
                event_type=EVENT_TOOL_FAILED,
                tool_name=name,
                detail={"error": type(e).__name__},
            )
            # Don't surface the exception message to the user / model;
            # it can leak internals. A generic error is plenty.
            err_msg = "The tool failed unexpectedly."
            yield (
                sse_yield(
                    {
                        "event": "tool_finished",
                        "id": call_id,
                        "name": name,
                        "ok": False,
                        "error": err_msg,
                    }
                ),
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": err_msg,
                },
            )
            continue

        # 5) Audit the success.
        await _audit_tool_event(
            db,
            request=request,
            user=user,
            event_type=EVENT_TOOL_INVOKED,
            tool_name=name,
        )

        # 6) Resolve any attachment ids the tool produced into the same
        #    chip-snapshot shape user uploads use, so the frontend
        #    renders them next to the assistant bubble identically.
        attachment_snaps: list[dict[str, Any]] = []
        if result.attachment_ids:
            rows = (
                (
                    await db.execute(
                        select(UserFile).where(
                            UserFile.id.in_(result.attachment_ids)
                        )
                    )
                )
                .scalars()
                .all()
            )
            # Preserve the order the tool returned ids in.
            by_id = {r.id: r for r in rows}
            for fid in result.attachment_ids:
                row = by_id.get(fid)
                if row is None:
                    continue
                snap = attachment_snapshot(row)
                attachment_snaps.append(snap)
                on_attachment(snap)

        # 7) Drain any web citations the tool collected (Phase D1) into
        #    the per-stream sources accumulator so they end up on
        #    ``messages.sources`` exactly like the legacy "always-mode"
        #    pre-search did. The accumulator is owned by the caller —
        #    keeping the dispatch loop ignorant of the merge strategy
        #    means a future "deep research" tool that wants to push
        #    sources mid-turn can use the same hook unchanged.
        if result.sources and on_sources is not None:
            on_sources(result.sources)

        # Sum any tool-reported USD spend into the per-message total so
        # the assistant message bubble can show "this turn cost ~$x"
        # including image-gen + future paid tools (currently only
        # generate_image emits ``meta["cost_usd"]``).
        if on_cost is not None and isinstance(result.meta, dict):
            tool_cost = result.meta.get("cost_usd")
            if isinstance(tool_cost, (int, float)) and tool_cost > 0:
                on_cost(float(tool_cost))

        yield (
            sse_yield(
                {
                    "event": "tool_finished",
                    "id": call_id,
                    "name": name,
                    "ok": True,
                    "attachments": attachment_snaps or None,
                    "sources": result.sources or None,
                    "meta": result.meta or None,
                }
            ),
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": result.content,
            },
        )


async def _stream_generator(
    stream_id: uuid.UUID, user: User, request: Request
) -> AsyncGenerator[str, None]:
    """The actual token-producing generator for the SSE response.

    Uses its own short-lived DB session because the FastAPI-managed session
    from `Depends(get_db)` is torn down as soon as the handler returns, well
    before the generator finishes yielding.
    """
    ctx = await consume_stream(stream_id)
    if ctx is None:
        yield _sse({"error": "Stream not found or expired"})
        yield _sse({"done": True})
        return

    conv_id = uuid.UUID(ctx["conversation_id"])
    provider_id = uuid.UUID(ctx["provider_id"])
    triggering_user_msg_id = uuid.UUID(ctx["user_message_id"])
    # Continue-generation (Phase 3.1): when set, we resume a truncated
    # assistant reply rather than producing a new one. Parsed up front so
    # the history-builder and the finalize step can both branch on it.
    _continue_raw = ctx.get("continue_from_message_id")
    continue_from_id = uuid.UUID(_continue_raw) if _continue_raw else None

    async with SessionLocal() as db:
        conv = await db.get(Conversation, conv_id)
        if conv is None or conv.user_id != user.id:
            yield _sse({"error": "Conversation not found"})
            yield _sse({"done": True})
            return

        provider = await db.get(ModelProvider, provider_id)
        if provider is None:
            yield _sse({"error": "Provider no longer exists"})
            yield _sse({"done": True})
            return

        # ------------------------------------------------------------------
        # Custom Models resolution.
        #
        # If the conversation's model id is a synthetic ``custom:<uuid>``
        # reference, swap in the base provider + base model id for the
        # rest of this generator. We deliberately mutate ``ctx["model_id"]``
        # in place so every downstream helper that reads it
        # (``_model_supports_vision``, the ``model_router.stream_chat_events``
        # call, ``distill_query``, etc.) sees the resolved base model
        # without any per-call conditionals.
        #
        # ``custom_assistant`` stays around so the system-prompt merge
        # later on can splice the assistant's personality + the top-K
        # retrieved knowledge block above the tools / personal-context
        # layers.
        # ------------------------------------------------------------------
        from app.custom_models.resolver import (
            is_custom_model_id,
            resolve_custom_model,
        )

        custom_assistant = None
        if is_custom_model_id(ctx["model_id"]):
            resolved = await resolve_custom_model(ctx["model_id"], db)
            if resolved is None:
                yield _sse(
                    {
                        "error": (
                            "This custom model is no longer available — "
                            "ask an admin to re-create it or pick a different model."
                        )
                    }
                )
                yield _sse({"done": True})
                return
            custom_assistant = resolved.custom_model
            provider = resolved.base_provider
            ctx["model_id"] = resolved.base_model_id

        # Build message history from DB. Phase 2.6 — follow the lineage
        # from the triggering user message back to the root rather than
        # taking every row in ``created_at`` order. Now that regenerate /
        # edit keep alternate answers as siblings instead of deleting
        # them, a flat created_at scan would wrongly fold off-path
        # versions into the prompt. The parent chain gives exactly the
        # active context that produced this turn.
        all_rows = (
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
        history_rows = lineage_to(all_rows, triggering_user_msg_id)
        if not history_rows:
            # Defensive fallback for any pre-0054 row whose parent chain
            # doesn't reach the triggering message: use the flat scan.
            history_rows = list(all_rows)

        # Look up vision support for the currently selected model so we
        # know whether to actually feed image bytes or fall back to a
        # textual marker + warning. Falls open (False) if the catalog row
        # is missing — better to refuse vision than to send bytes a model
        # might 400 on.
        model_supports_vision = _model_supports_vision(provider, ctx["model_id"])

        # Resolve every attachment referenced by every user turn in one
        # query, then re-shape per-message. Doing this once up-front keeps
        # the loop below readable and cheap.
        per_message_attachments = await _load_message_attachments(
            db, history_rows, user
        )

        # Phase P1 — Workspaces. When the conversation belongs to a
        # workspace, fold its pinned files into the *triggering* turn's
        # attachment list so they flow through the existing
        # ``build_attachment_preamble`` / vision pipeline without any
        # duplicate plumbing. The workspace's ``system_prompt`` is
        # handled later (see ``workspace_system_prompt`` below) where it
        # slots in alongside the tools-aware and personal-context
        # prompts.
        workspace_system_prompt: str | None = None
        if conv.workspace_id is not None:
            # Walk the workspace-share ACL so a collaborator's send
            # still picks up the workspace's system prompt + pinned
            # files. Owner check first (common path); fall back to
            # :func:`_has_workspace_access` for accepted collaborators.
            workspace_row = await db.get(Workspace, conv.workspace_id)
            caller_has_workspace = False
            if workspace_row is not None:
                if workspace_row.user_id == user.id:
                    caller_has_workspace = True
                else:
                    # Import locally to avoid a cycle — ``shares``
                    # imports ``workspaces.shares`` which imports this
                    # router indirectly.
                    from app.chat.shares import _has_workspace_access

                    caller_has_workspace = await _has_workspace_access(
                        workspace_row.id, user, db
                    )
            if workspace_row is not None and caller_has_workspace:
                workspace_system_prompt = (
                    workspace_row.system_prompt.strip()
                    if workspace_row.system_prompt
                    else None
                ) or None

                # Phase P2 — hybrid retrieval. ``build_workspace_injection``
                # decides full-dump (small workspaces: every pinned file
                # folded into the turn, as before) vs. top-k retrieval
                # (large workspaces: only the relevant chunks spliced into
                # the system prompt; images + not-yet-indexed text still
                # ride the attachment path). Local import mirrors the
                # ``_has_workspace_access`` lazy import above — keeps the
                # already-heavy router import graph narrow.
                from app.workspaces.knowledge import (
                    WorkspaceInjection,
                    build_workspace_injection,
                )

                triggering_text = next(
                    (
                        m.content
                        for m in history_rows
                        if m.id == triggering_user_msg_id
                    ),
                    "",
                )
                # Per-chat opt-outs: files this conversation has excluded
                # from the workspace's shared set.
                excluded_ids = set(
                    (
                        await db.execute(
                            select(
                                ConversationExcludedWorkspaceFile.file_id
                            ).where(
                                ConversationExcludedWorkspaceFile.conversation_id
                                == conv.id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                # Gathering workspace context (pinned-file retrieval / query
                # embedding / pgvector search) must never take down the chat
                # turn. A single bad or mid-indexing file — or a transient
                # embedding-provider hiccup (prod uses a cloud embedder) —
                # would otherwise raise here and abort the whole stream, which
                # is exactly the "adding a file breaks chat until I remove it"
                # failure. Degrade to "no workspace context" and keep going,
                # mirroring the soft-fail of the vision relay below.
                try:
                    injection = await build_workspace_injection(
                        db,
                        workspace_id=workspace_row.id,
                        query=triggering_text or "",
                        excluded_file_ids=excluded_ids,
                    )
                except Exception:
                    logger.exception(
                        "workspace context gathering failed "
                        "(workspace_id=%s, conversation_id=%s); "
                        "proceeding without workspace context",
                        workspace_row.id,
                        conv.id,
                    )
                    injection = WorkspaceInjection()
                if injection.system_block:
                    # Workspace instructions stay first; the retrieved
                    # "Workspace knowledge" block sits under them.
                    workspace_system_prompt = (
                        merge_system_prompt(
                            workspace_system_prompt, injection.system_block
                        )
                        if workspace_system_prompt
                        else injection.system_block
                    )

                # ACL for pinned files in a (possibly shared) workspace:
                # anyone with workspace access can *use* any file pinned
                # there — the workspace itself is the access grant. Admin
                # pool files (``user_id IS NULL``) are always allowed.
                if injection.attach_file_ids:
                    pin_rows = await db.execute(
                        select(UserFile).where(
                            UserFile.id.in_(injection.attach_file_ids)
                        )
                    )
                    by_id = {f.id: f for f in pin_rows.scalars().all()}
                    # Preserve pin order (``attach_file_ids`` is ordered).
                    pinned_files = [
                        by_id[fid]
                        for fid in injection.attach_file_ids
                        if fid in by_id
                    ]
                    existing = per_message_attachments.get(
                        triggering_user_msg_id, []
                    )
                    existing_ids = {f.id for f in existing}
                    # Prepend so workspace pins render first in the
                    # preamble ("Workspace files: ..." reads naturally
                    # before "this turn's attachments: ..."). Skip
                    # any file the user *also* attached to this very
                    # turn to avoid duplicated text blobs.
                    merged = [
                        f for f in pinned_files if f.id not in existing_ids
                    ] + list(existing)
                    per_message_attachments[triggering_user_msg_id] = merged

        # ---- Vision relay (pre-history-build) ----
        # When the user's turn carries images AND the active chat model
        # can't read them natively AND an admin-configured relay is
        # available, run each image through the relay model to produce
        # a text caption. The caption is then spliced into the
        # triggering turn's text content below, replacing what would
        # otherwise be a "model can't see images" warning with actual
        # description content. A chip pair (started/finished) is
        # emitted per image so the user sees what happened.
        triggering_files = per_message_attachments.get(triggering_user_msg_id, [])
        triggering_image_files = [f for f in triggering_files if looks_image(f)]
        has_image = bool(triggering_image_files)

        # Single load of the singleton settings row used by both the
        # relay decision here and the tool-cap dict further down. Done
        # once so an admin editing the row mid-stream can't cause the
        # two reads to disagree.
        app_settings_row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        relay_provider_row: ModelProvider | None = None
        relay_will_run = (
            has_image
            and not model_supports_vision
            and app_settings_row is not None
            and app_settings_row.vision_relay_configured
        )
        if relay_will_run and app_settings_row is not None:
            relay_provider_row = await db.get(
                ModelProvider, app_settings_row.vision_relay_provider_id
            )
            if relay_provider_row is None:
                # Provider was deleted between settings-write and now;
                # collapse to the existing "cannot read images"
                # warning path so the user gets a clear signal that
                # the relay isn't usable.
                relay_will_run = False

        # Surface vision warnings to the client. We only warn for the
        # *triggering* turn — older turns with images already produced
        # a reply, the user has long since seen the consequence. The
        # "model cannot read images" message is suppressed when the
        # relay will run; the chip pair we emit below carries the same
        # information in a more useful form.
        triggering_warnings: list[str] = []
        if has_image and not model_supports_vision and not relay_will_run:
            triggering_warnings.append(
                f"The selected model ({ctx['model_id']}) cannot read "
                "images. Image attachments will be acknowledged by "
                "filename but their visual contents won't be sent. "
                "Pick a vision-capable model to have the AI actually "
                "see them — or ask an admin to configure a Vision "
                "relay model under Admin → Settings."
            )

        # Capture whether this stream will produce the conversation's first
        # assistant turn — that's when we generate the AI title.
        # A continuation never re-titles: the conversation already had a
        # reply, and the streamed text is only the tail of an existing one.
        is_first_turn = continue_from_id is None and not any(
            m.role == "assistant" for m in history_rows
        )
        first_user_message = next(
            (m.content for m in history_rows if m.role == "user"), ""
        )

        # ---- SSE start ----
        # Emitted earlier than it used to be (it lived after the
        # history build) so the assistant bubble + chip area on the
        # frontend can appear before any potentially-slow vision-relay
        # captioning calls fire. Without this the user would stare at
        # an empty placeholder for several seconds while we relay each
        # image, with no indication anything was happening.
        yield _sse({"event": "start", "stream_id": str(stream_id)})

        # ---- Vision relay loop ----
        # Captioning calls run serially (NOT in parallel) — the relay
        # endpoint is typically a single provider and parallel image
        # captions wouldn't pipeline faster on most upstreams while
        # also making the chip animation jarring. Each image gets a
        # ``vision_relay_started`` chip immediately, then the call
        # blocks until the caption (or error) lands, then we yield
        # ``vision_relay_finished``. Failed captions are surfaced as
        # red chips and dropped from the spliced preamble — the main
        # chat turn still fires so the user isn't left with nothing.
        from app.chat.vision_relay import (  # local — sibling module
            CaptionResult,
            caption_image,
            format_captions_as_text,
        )

        caption_results: list[tuple[uuid.UUID, str, CaptionResult]] = []
        if (
            relay_will_run
            and relay_provider_row is not None
            and app_settings_row is not None
            and app_settings_row.vision_relay_model_id
        ):
            triggering_user_msg_row = next(
                (m for m in history_rows if m.id == triggering_user_msg_id),
                None,
            )
            user_question = (
                (triggering_user_msg_row.content or "")
                if triggering_user_msg_row is not None
                else ""
            )
            for idx, image_file in enumerate(triggering_image_files, start=1):
                yield _sse(
                    {
                        "event": "vision_relay_started",
                        "id": str(image_file.id),
                        "index": idx,
                        "filename": image_file.filename,
                        "relay_provider_name": relay_provider_row.name,
                        "relay_model_id": (
                            app_settings_row.vision_relay_model_id
                        ),
                    }
                )
                result = await caption_image(
                    db=db,
                    image_file=image_file,
                    user_question=user_question,
                    relay_provider=relay_provider_row,
                    relay_model_id=app_settings_row.vision_relay_model_id,
                )
                caption_results.append(
                    (image_file.id, image_file.filename, result)
                )
                yield _sse(
                    {
                        "event": "vision_relay_finished",
                        "id": str(image_file.id),
                        "ok": result.ok,
                        "caption": result.text,
                        "error": result.error,
                    }
                )

        # Pre-compute the caption-preamble string once so the per-row
        # history build below just splices it in (cheap append). Empty
        # string when the relay didn't run or every caption failed —
        # the splice becomes a no-op in those cases.
        caption_preamble = (
            format_captions_as_text(caption_results) if caption_results else ""
        )
        # If at least one caption succeeded the model genuinely has
        # image context to work with, so we flip
        # ``vision_handles_images`` on for the attachment preamble.
        # That swaps the "model cannot read images" filler line for
        # the friendlier "image bytes are provided separately" copy
        # (which is true in spirit — the caption is the model's
        # window into the image).
        any_caption_ok = any(r[2].ok for r in caption_results)
        vision_effective = model_supports_vision or any_caption_ok

        history: list[ChatMessage] = []
        for m in history_rows:
            if m.role not in ("user", "assistant", "system"):
                continue
            base_text = m.content or ""

            attachments = per_message_attachments.get(m.id, [])
            is_triggering = m.id == triggering_user_msg_id

            # Text/PDF preamble: only on the triggering turn. Prior turns
            # already produced an assistant reply with the file context
            # baked in, so re-feeding the text would waste tokens.
            if is_triggering and attachments:
                preamble = build_attachment_preamble(
                    attachments, vision_handles_images=vision_effective
                )
            else:
                preamble = ""

            # Splice the vision-relay caption block in front of the
            # standard preamble for the triggering turn. Caption block
            # first because it's the substantive content; the
            # ``build_attachment_preamble`` block then references the
            # files by name underneath.
            if is_triggering and caption_preamble:
                preamble = caption_preamble + preamble

            full_text = preamble + base_text

            # Image bytes: re-fed on EVERY user turn that had them, so the
            # model can keep referring back to the picture across multi-
            # turn conversations. Vision-incapable models silently drop
            # the bytes — when relay ran successfully the caption above
            # carries the visual content instead.
            image_parts: list[ImagePart] = []
            if model_supports_vision and attachments:
                images, _img_warnings = build_image_parts(
                    [f for f in attachments if looks_image(f)]
                )
                # We only add per-image warnings (oversize, IO error) for
                # the triggering turn; older turns shipping fine before
                # don't need to re-warn even if the file changed since.
                if is_triggering:
                    triggering_warnings.extend(_img_warnings)
                image_parts = images

            # Hydrate DeepSeek thinking-mode chain-of-thought on
            # assistant rows. NULL on non-DeepSeek providers and on
            # turns where thinking was off — the dataclass field
            # stays ``None`` and ``to_openai`` skips it. The
            # provider stream-prep strips it again for non-DeepSeek
            # providers as a belt-and-braces safety net.
            reasoning = (
                getattr(m, "reasoning_content", None)
                if m.role == "assistant"
                else None
            )

            if image_parts:
                # Multimodal turn: TextPart first so the question reads
                # naturally above the image(s) in the model's context.
                content_parts: list[ContentPart] = []
                if full_text:
                    content_parts.append(TextPart(text=full_text))
                content_parts.extend(image_parts)
                history.append(
                    ChatMessage(
                        role=m.role,
                        content=content_parts,
                        reasoning_content=reasoning,
                    )
                )
            else:
                # Plain text turn — keep the legacy str path so wire
                # format stays byte-identical to pre-Phase 4 behaviour.
                if not full_text:
                    continue
                history.append(
                    ChatMessage(
                        role=m.role,
                        content=full_text,
                        reasoning_content=reasoning,
                    )
                )

        # Forward any vision-related warnings (non-vision model + image
        # attachment with no relay configured, oversized image, etc.)
        # so the UI can surface them above the tool chips.
        for warning in triggering_warnings:
            yield _sse({"event": "vision_warning", "message": warning})

        # ---- Resolve enabled tool categories (Phase D1) ----
        # Two independent toggles drive what tools[] the model gets:
        #   * ``tools_enabled`` (per-turn) → artefact tools (PDF, image)
        #   * ``web_search_mode`` (per-conv, off/auto/always) → search
        #     tools (web_search, fetch_url)
        # Either, both, or neither category may be active.
        web_search_mode = ctx.get("web_search_mode") or "off"
        if web_search_mode not in ("off", "auto", "always"):
            # Defensive: an unknown value (older payload, bad data)
            # collapses to the safest behaviour rather than crashing
            # mid-stream.
            web_search_mode = "off"

        # Voice mode (Phase 2): a spoken turn. Drives the brevity system
        # prompt (merged last, below) + a token backstop so a runaway reply
        # can't drone on when read aloud. Only applied when the client
        # didn't set its own explicit cap.
        voice_turn = bool(ctx.get("voice"))
        if voice_turn and ctx.get("max_tokens") is None:
            ctx["max_tokens"] = VOICE_MAX_TOKENS

        enabled_categories: set[str] = set()
        if ctx.get("tools_enabled"):
            enabled_categories.add("artefact")
            # Phase 4 — the code interpreter rides on the same Tools
            # toggle as the artefact generators.
            enabled_categories.add("code")
        if web_search_mode != "off":
            enabled_categories.add("search")

        tools_payload: list[dict[str, Any]] | None = (
            list_openai_tools(enabled_categories) if enabled_categories else None
        )

        # Phase P1 — workspace-level instructions are the baseline
        # system prompt. Tool-aware + personal-context prompts are
        # merged on top below, each taking precedence (since
        # ``merge_system_prompt`` puts the first argument first).
        # Promptly base guidelines (lowest priority — every user/workspace/tool
        # layer stacked on top overrides these). Covers rendering capabilities
        # (KaTeX, markdown tables) and basic response quality steer.
        system_prompt: str | None = merge_system_prompt(
            workspace_system_prompt or "", PROMPTLY_BASE_PROMPT
        )
        # Account-wide custom system prompt. A global persona / standing
        # instruction the user set in Chat defaults that seeds EVERY new
        # chat. It's the broadest steer, so it sits *under* both the
        # workspace prompt and the per-chat instructions — we merge it as
        # the base (second arg wins least) so anything more specific
        # overrides it. Empty / whitespace-only is treated as unset.
        account_prompt = (user.settings or {}).get("custom_system_prompt")
        account_prompt = (
            account_prompt.strip() if isinstance(account_prompt, str) else None
        )
        if account_prompt:
            system_prompt = merge_system_prompt(system_prompt or "", account_prompt)
        # Per-conversation custom instructions (Phase 1). A free-text
        # steer ("answer concisely", "you're a Rust expert") that lives
        # on the chat itself — narrower than the project prompt, so it
        # takes precedence over it but still sits *under* the tool /
        # personal-context layers merged on below.
        conv_instructions = (conv.system_prompt or "").strip() or None
        if conv_instructions:
            system_prompt = merge_system_prompt(
                conv_instructions, system_prompt or ""
            )
        # Sources accumulator (Phase D1). Drained from any web_search /
        # fetch_url tool call this turn (whether forced via "always" or
        # initiated by the model in "auto" mode). Persisted onto
        # ``messages.sources`` after the hop loop so the inline citation
        # chips + the SourcesFooter UI keep working unchanged.
        sources_accumulator: list[dict[str, Any]] = []

        # Working history that grows across hops. Starts as the typed
        # ChatMessage list; from hop 2 onward we append raw OpenAI
        # dicts (assistant + tool messages) directly because there's
        # no first-class ChatMessage representation for those shapes.
        running_history: list[ChatMessage | dict[str, Any]] = list(history)

        # Continue-generation (Phase 3.1): splice the truncated reply's
        # existing text into the prompt as a scaffold turn so the model
        # resumes seamlessly. This turn is in-memory only (never persisted)
        # and the streamed continuation is appended onto the existing
        # assistant row in the finalize step below.
        continue_target: Message | None = None
        if continue_from_id is not None:
            continue_target = await db.get(Message, continue_from_id)
            partial = (continue_target.content or "") if continue_target else ""
            if partial.strip():
                running_history.append(
                    ChatMessage(
                        role="user",
                        content=(
                            "Your previous reply was cut off because it hit "
                            "the output-length limit. Here is everything you "
                            "have written so far:\n\n-----\n"
                            f"{partial}\n-----\n\n"
                            "Continue the reply seamlessly from exactly where "
                            "it stopped. Do not repeat any text you already "
                            "wrote, do not restate earlier points, and do not "
                            "add a preamble like 'continuing' — just produce "
                            "the next part so the whole thing reads as one "
                            "continuous response."
                        ),
                    )
                )

        collected_text: list[str] = []
        # DeepSeek thinking-mode chain-of-thought, accumulated across
        # hops the same way ``collected_text`` is. Persisted on the
        # final assistant message so we can replay it on follow-up
        # turns — DeepSeek 400s on tool-call multi-turn conversations
        # when the prior assistant's ``reasoning_content`` is missing
        # (see migration ``0049_msgs_reasoning``). Other providers
        # never emit it; this stays an empty list and the column
        # ends up NULL.
        collected_reasoning: list[str] = []
        assistant_attachment_snaps: list[dict[str, Any]] = []
        prompt_tokens: int | None = None
        completion_tokens: int | None = None
        # Sum of provider-reported USD cost across hops + tool
        # invocations. ``None`` until at least one hop / tool actually
        # reports a cost so we can distinguish "free / unknown" from
        # "$0.00" on the message-stats UI.
        cost_usd: float | None = None
        stream_start = time.monotonic()
        first_token_at: float | None = None
        # Per-turn invocation counter. The dispatch loop reads + bumps
        # this so a tool with ``max_per_turn`` can be enforced across
        # the entire tool-calling loop (not just within a single hop).
        tool_invocation_counts: dict[str, int] = {}

        # Admin-tunable per-tool caps loaded once for this stream so
        # both the forced "always" web_search and the regular tool
        # loop see the same value, even if an admin edits the setting
        # mid-stream. Falls back to the tool-class default
        # (``Tool.max_per_turn``) inside ``_dispatch_tools`` when this
        # dict is missing an entry — keeps behaviour stable if the
        # singleton row is somehow unreadable. Reuses the row loaded
        # earlier for the vision-relay decision so an admin editing
        # the settings mid-stream can't cause this read to disagree
        # with that one.
        per_tool_caps: dict[str, int] = {}
        if app_settings_row is not None:
            per_tool_caps["web_search"] = (
                app_settings_row.chat_max_web_searches_per_turn
            )

        def _record_tool_cost(c: float) -> None:
            # Mutates the enclosing ``cost_usd`` accumulator without
            # ``nonlocal`` boilerplate at every call site.
            nonlocal cost_usd
            cost_usd = (cost_usd or 0.0) + c

        # ---- "always" mode: synthesise a forced web_search call ----
        # Instead of the legacy system-prompt RAG injection, we now
        # synthesise a tool-call as if the model itself had decided to
        # search. That gives us a single uniform code path (and UI
        # rendering) for forced-vs-model-initiated searches: both flow
        # through ``_dispatch_tools``, both produce a ``tool_started``
        # → ``tool_finished`` SSE pair, both surface as a tool chip,
        # and both feed the result back into history as a real ``tool``
        # message rather than a system-prompt blob the model can't
        # reason about as cleanly.
        if (
            web_search_mode == "always"
            and "search" in enabled_categories
        ):
            last_user = next(
                (m.content for m in reversed(history_rows) if m.role == "user"),
                "",
            )
            forced_query = await distill_query(
                last_user,
                llm_provider=provider,
                llm_model_id=ctx["model_id"],
            )
            if forced_query.strip():
                forced_call_id = f"forced_search_{uuid.uuid4().hex[:8]}"
                forced_args = json.dumps({"query": forced_query})
                running_history.append(
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": forced_call_id,
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": forced_args,
                                },
                            }
                        ],
                    }
                )
                forced_tool_ctx = ToolContext(
                    db=db,
                    user=user,
                    conversation_id=conv.id,
                    user_message_id=triggering_user_msg_id,
                )
                async for sse_event, tool_history_msg in _dispatch_tools(
                    db=db,
                    request=request,
                    user=user,
                    pending_calls={
                        0: {
                            "id": forced_call_id,
                            "name": "web_search",
                            "arguments": forced_args,
                        }
                    },
                    ctx=forced_tool_ctx,
                    sse_yield=_sse,
                    on_attachment=assistant_attachment_snaps.append,
                    on_sources=sources_accumulator.extend,
                    on_cost=_record_tool_cost,
                    invocation_counts=tool_invocation_counts,
                    per_tool_caps=per_tool_caps,
                ):
                    yield sse_event
                    if tool_history_msg is not None:
                        running_history.append(tool_history_msg)

        # When tools are on, *prepend* a tool-aware system prompt that
        # explicitly tells the model "yes you can do this, just call
        # the tool". Sidesteps the common refusal pattern (Gemini in
        # particular) where the model insists it can't produce binary
        # artefacts even with a valid tools[] payload in scope.
        if enabled_categories:
            system_prompt = merge_system_prompt(
                build_tools_system_prompt(enabled_categories),
                system_prompt or "",
            )

        # Ambient personal context (date, time, location). Phrased as
        # background knowledge with an explicit "do not call attention
        # to it" instruction so the model just *knows* the user is on
        # the Sunshine Coast without thanking them for sharing it
        # every turn. Returns ``None`` for users who haven't filled
        # any of these fields, so the existing prompt is untouched
        # and there's zero token overhead for the default account.
        personal_context = build_personal_context_prompt(user)
        if personal_context:
            system_prompt = merge_system_prompt(
                personal_context, system_prompt or ""
            )

        # Phase 6 — cross-chat memory. Inject the user's saved durable
        # facts as background knowledge (same "don't recite it" framing as
        # personal context) so the assistant carries personalisation across
        # conversations. Gated by the per-user ``memory_enabled`` switch
        # (absent = on); returns ``None`` when the user has no memories, so
        # there's zero token overhead for fresh accounts.
        # Resolve the memory mode (off / auto / manual). ``memory_mode``
        # supersedes the legacy ``memory_enabled`` boolean; fall back to
        # it for accounts that predate the three-way setting.
        _mem_settings = user.settings or {}
        memory_mode = _mem_settings.get("memory_mode")
        if memory_mode not in ("off", "auto", "manual"):
            memory_mode = (
                "off"
                if _mem_settings.get("memory_enabled", True) is False
                else "auto"
            )
        # Resolve the triggering user message early — both memory
        # retrieval (below) and @-mention resolution (further down) key
        # off its text. Defined here so the memory block can use it.
        trig_row = next(
            (m for m in history_rows if m.id == triggering_user_msg_id),
            None,
        )

        # Saved facts are injected in both auto and manual modes — manual
        # only changes whether we *capture* new ones (see below).
        memory_enabled = memory_mode != "off"
        # memories_used: the facts actually injected this turn; emitted via
        # a ``memory_used`` SSE event for in-chat transparency (Phase 3.2).
        memories_used = []
        if memory_enabled:
            # Inject only the facts relevant to this turn (semantic top-K);
            # falls back to most-recent when embeddings aren't configured.
            # Returns (rendered_block | None, list[UserMemory]) (Phase 3.2).
            memory_block, memories_used = await build_memory_system_prompt(
                db,
                user.id,
                query=(trig_row.content if trig_row is not None else None),
                k=MEMORY_RETRIEVAL_K,
            )
            if memory_block:
                system_prompt = merge_system_prompt(
                    memory_block, system_prompt or ""
                )

        # Phase C — @-mention resolution. Scan the triggering user
        # message for ``@[title](id)`` tokens, verify the caller has
        # read access to each referenced chat, and prepend a block
        # of their cached summaries to the system prompt so the
        # model picks up the relevant context. Failures (provider
        # error, inaccessible id, chat too short) drop individual
        # references without blocking the send — the raw tokens
        # still render as chips in the user's message.
        if trig_row is not None and trig_row.content:
            mentions_found = extract_mentions(trig_row.content)
            if mentions_found:
                refs = await resolve_mentions(
                    mentions_found,
                    caller=user,
                    exclude_conversation_id=conv.id,
                    llm_provider=provider,
                    llm_model_id=ctx["model_id"],
                    db=db,
                )
                ref_block = build_reference_system_block(refs)
                if ref_block:
                    # Mentions land on top (first arg to
                    # ``merge_system_prompt``) so the model reads
                    # "you've been given these reference chats"
                    # before the longer-lived project / tool /
                    # personal layers.
                    system_prompt = merge_system_prompt(
                        ref_block, system_prompt or ""
                    )

            # Drive-file @-mentions (Phase 2.2). Resolve each referenced
            # file the caller can read and inject its extracted text as
            # background context. Access control + text extraction are
            # delegated to the files package; unreadable / missing files
            # are dropped silently so a stale token can't block the send.
            file_mentions_found = extract_file_mentions(trig_row.content)
            if file_mentions_found:
                # NB: do NOT re-import UserFile here. It's already imported at
                # module scope; a local ``import UserFile`` would make the name
                # function-local for the whole generator and turn the earlier
                # workspace-pin reference (select(UserFile)) into an
                # UnboundLocalError whenever this @-mention branch is skipped.
                from app.files.router import _load_readable_file

                resolved_files: list[UserFile] = []
                for fm in file_mentions_found:
                    try:
                        uf = await _load_readable_file(db, fm.file_id, user)
                    except Exception:
                        logger.info(
                            "Dropping file mention %s — not accessible to %s",
                            fm.file_id,
                            user.id,
                        )
                        continue
                    resolved_files.append(uf)
                file_block = build_file_mention_block(resolved_files)
                if file_block:
                    system_prompt = merge_system_prompt(
                        file_block, system_prompt or ""
                    )

        # ------------------------------------------------------------------
        # Custom Models — personality + retrieved knowledge.
        #
        # Merged last so the personality sits at the very top of the
        # system prompt (highest priority). ``merge_system_prompt`` is
        # first-arg-wins, so folding personality on top of whatever the
        # earlier merges produced preserves each layer's original
        # intent while giving the assistant's voice the last word.
        #
        # Retrieval failures (no embedding provider configured, embed
        # call timed out, no chunks yet indexed) degrade silently into
        # a personality-only chat — better than crashing the stream
        # mid-send when the user just wanted to talk to their pet LLM.
        # ------------------------------------------------------------------
        if custom_assistant is not None:
            from app.custom_models.retrieval import (
                format_retrieved_block,
                retrieve_context,
            )

            # Source of truth for the retrieval query: the last user
            # turn in the conversation history. Falls back to the
            # triggering message id when the ordered history look-up
            # doesn't land (defensive — shouldn't happen in practice
            # since the user turn was just persisted).
            query_source = next(
                (m.content for m in reversed(history_rows) if m.role == "user"),
                None,
            ) or (trig_row.content if trig_row is not None else "")
            retrieved = []
            if query_source:
                try:
                    retrieved = await retrieve_context(
                        db,
                        custom_model=custom_assistant,
                        query=query_source,
                    )
                except Exception:  # noqa: BLE001 - best-effort retrieval
                    logger.exception(
                        "custom_model retrieve_context failed; falling back to "
                        "personality-only"
                    )
                    retrieved = []

            blocks: list[str] = []
            if custom_assistant.personality:
                blocks.append(custom_assistant.personality.strip())
            knowledge_block = format_retrieved_block(retrieved)
            if knowledge_block:
                blocks.append(knowledge_block)

            if blocks:
                system_prompt = merge_system_prompt(
                    "\n\n".join(blocks), system_prompt or ""
                )

        # Voice mode (Phase 2): a spoken turn. Merge the brevity steer
        # LAST so it's the highest-priority layer — format/length for
        # speech should win over any verbose persona or instruction.
        if voice_turn:
            system_prompt = merge_system_prompt(
                VOICE_SYSTEM_PROMPT, system_prompt or ""
            )

        # Phase 3.2 — in-chat transparency. Emit which facts were injected
        # this turn so the UI can show a "🧠 N memories in context" chip.
        # Best-effort: never blocks the stream if it fails.
        if memories_used:
            yield _sse(
                {
                    "event": "memory_used",
                    "facts": [m.content for m in memories_used],
                    "ids": [str(m.id) for m in memories_used],
                    "count": len(memories_used),
                }
            )

        # Holds the final hop's ``finish_reason`` after the loop breaks
        # so the ``done`` event can flag truncation (``"length"``).
        # Initialised here so it's always bound even on the (impossible)
        # zero-iteration path.
        hop_finish: str | None = None
        try:
            for hop in range(MAX_TOOL_HOPS):
                # Accumulators for the *current* hop. Tool-call deltas
                # come back fragmented per ``index``; we merge by index.
                hop_text_parts: list[str] = []
                # DeepSeek thinking-mode chain-of-thought for this
                # hop. Captured separately so we can attach it to
                # the assistant turn appended to ``running_history``
                # when this hop ends in a tool call (the API requires
                # ``reasoning_content`` on assistant turns of tool-
                # call multi-turn DeepSeek conversations).
                hop_reasoning_parts: list[str] = []
                # Each entry: {"id": str, "name": str, "arguments": str}
                pending_calls: dict[int, dict[str, str]] = {}
                hop_finish = None

                # Forced-finish on the final hop: stack THREE signals so
                # whichever the active provider honours, the model is
                # forced to synthesise a text reply instead of calling
                # yet another tool.
                #
                #   1. ``tools=None`` — drop the tool schema entirely
                #      so the API has no functions to bind ``tool_calls``
                #      against. OpenAI / Anthropic / DeepSeek / Ollama
                #      treat this as "no tools available".
                #   2. ``tool_choice="none"`` — only meaningful when
                #      tools is non-empty per OpenAI spec, so it's set
                #      to ``None`` here too. (We keep the parameter
                #      threaded for non-final hops in case we ever
                #      need it.)
                #   3. **Synthesis instruction injected into the system
                #      prompt** — the cross-provider safety net. Some
                #      models (Gemini's OpenAI-compat layer is the
                #      usual culprit) ignore ``tool_choice="none"`` AND
                #      pattern-match the conversation history into more
                #      tool calls even with no schema. An explicit
                #      "you have no tools left, write the answer now"
                #      instruction in the system prompt is the only
                #      cross-provider thing that reliably stops them.
                #
                # Combined with the unconditional ``break`` further
                # down on ``is_final_hop``, a still-misbehaving model
                # that emits tool_calls anyway can't pull us past the
                # cap; and the post-loop empty-text check provides a
                # last-resort error chip.
                is_final_hop = hop == MAX_TOOL_HOPS - 1
                hop_tools = None if is_final_hop else tools_payload
                hop_tool_choice = None
                hop_system = system_prompt
                if is_final_hop and tools_payload:
                    forced_finish_note = (
                        "\n\n[FORCED FINISH] You have used all "
                        "available tool calls for this turn. Do not "
                        "attempt to call any more tools — none are "
                        "available. Write your final answer to the "
                        "user's question now using the information "
                        "you have already gathered. If the gathered "
                        "information is incomplete, explicitly say "
                        "what's missing and answer with what you have."
                    )
                    hop_system = (system_prompt or "") + forced_finish_note
                    # Surface a heads-up SSE event so the frontend can
                    # render a subtle "wrapping up" affordance instead
                    # of leaving the user staring at a long tool-call
                    # run with no obvious next step. Not an error —
                    # just a transition cue.
                    yield _sse(
                        {
                            "event": "tool_loop_wrapping_up",
                            "hops_used": hop,
                            "max_hops": MAX_TOOL_HOPS,
                        }
                    )

                async for ev in model_router.stream_chat_events(
                    provider=provider,
                    model_id=ctx["model_id"],
                    messages=running_history,
                    system=hop_system,
                    temperature=ctx["temperature"],
                    max_tokens=ctx["max_tokens"],
                    tools=hop_tools,
                    tool_choice=hop_tool_choice,
                    include_usage=True,
                    # ``.get`` so stream contexts written by older
                    # backend builds (the Redis TTL is 60s, but
                    # there's a window during deploy where pre-update
                    # contexts could still be consumed) parse cleanly.
                    reasoning_effort=ctx.get("reasoning_effort"),
                ):
                    # Note: we used to bail on ``request.is_disconnected``
                    # here, which meant closing the tab dropped the reply
                    # on the floor. Generation now runs in a background
                    # task (see stream_runner.py) so the user can navigate
                    # away and the assistant message still lands in the
                    # DB. Cancellation only happens on process shutdown.
                    if isinstance(ev, TextDelta):
                        if first_token_at is None:
                            first_token_at = time.monotonic()
                        hop_text_parts.append(ev.text)
                        yield _sse({"delta": ev.text})

                    elif isinstance(ev, ReasoningDelta):
                        # Accumulate-only: no SSE forward today so the
                        # UI doesn't have to render a thinking pane
                        # for a feature shipping the same week. The
                        # chain-of-thought still gets persisted +
                        # replayed which is what fixes the DeepSeek
                        # 400. A future patch can add a streaming
                        # "thoughts" channel without changing the
                        # persistence layer.
                        hop_reasoning_parts.append(ev.text)

                    elif isinstance(ev, ToolCallDelta):
                        slot = pending_calls.setdefault(
                            ev.index, {"id": "", "name": "", "arguments": ""}
                        )
                        if ev.id:
                            slot["id"] = ev.id
                        if ev.name:
                            slot["name"] = ev.name
                        if ev.arguments:
                            slot["arguments"] += ev.arguments

                    elif isinstance(ev, UsageEvent):
                        # Usage deltas accumulate across hops — sum so
                        # the user is billed for *every* round-trip the
                        # tool loop made on their behalf.
                        if ev.prompt_tokens is not None:
                            prompt_tokens = (prompt_tokens or 0) + ev.prompt_tokens
                        if ev.completion_tokens is not None:
                            completion_tokens = (
                                completion_tokens or 0
                            ) + ev.completion_tokens
                        if ev.cost_usd is not None:
                            cost_usd = (cost_usd or 0.0) + ev.cost_usd

                    elif isinstance(ev, FinishEvent):
                        hop_finish = ev.reason

                # Roll the hop's text into the conversation-wide buffer.
                hop_text = "".join(hop_text_parts)
                if hop_text:
                    collected_text.append(hop_text)
                hop_reasoning = "".join(hop_reasoning_parts)
                if hop_reasoning:
                    collected_reasoning.append(hop_reasoning)

                # We're done with the tool loop in one of three cases:
                #
                #   1. The model returned a plain text reply (no tool
                #      calls) — the normal happy path.
                #   2. ``hop_finish`` is something other than
                #      ``tool_calls`` (e.g. ``stop`` / ``length``) —
                #      we trust the upstream signal and stop.
                #   3. We're on the forced-finish hop. Even if the
                #      model emitted ``tool_calls`` despite the
                #      ``tool_choice="none"`` pin, we MUST NOT
                #      dispatch them — there are no hops left and
                #      doing so just trips the for-else cap path.
                #      Discard the misbehaving tool calls and persist
                #      whatever text accumulated; the post-loop
                #      empty-text check below covers the case where
                #      that text is empty.
                if (
                    is_final_hop
                    or hop_finish != "tool_calls"
                    or not pending_calls
                ):
                    # Diagnostic: tools were on but the model never
                    # actually called any. Useful for spotting models
                    # (Gemini-via-OpenRouter is the usual culprit) that
                    # silently drop ``tools[]`` without erroring. Logged
                    # at INFO so it shows up in normal operations
                    # tailing without polluting the audit log; no SSE
                    # event because the user already got a normal reply.
                    if hop == 0 and tools_payload and not pending_calls:
                        logger.info(
                            "Tools enabled but model declined to call any "
                            "(stream=%s model=%s tools=%d)",
                            stream_id,
                            ctx["model_id"],
                            len(tools_payload),
                        )
                    # Belt-and-braces logging for case 3: helps an
                    # operator spot the rare model that ignores
                    # ``tool_choice="none"`` so we can flag it for a
                    # provider-level allowlist later.
                    if is_final_hop and pending_calls:
                        logger.warning(
                            "Forced-finish hop returned tool_calls "
                            "despite tool_choice=none "
                            "(stream=%s model=%s pending=%d). Discarding.",
                            stream_id,
                            ctx["model_id"],
                            len(pending_calls),
                        )
                    break

                # ---- Dispatch the tools the model asked for ----
                # Append the assistant turn carrying the tool_calls so
                # the follow-up call has the right conversational shape.
                tool_calls_payload = _build_tool_calls_payload(pending_calls)
                assistant_tool_turn: dict[str, Any] = {
                    "role": "assistant",
                    # OpenAI's protocol allows null content here
                    # when the assistant produced only tool calls.
                    "content": hop_text or None,
                    "tool_calls": tool_calls_payload,
                }
                # DeepSeek thinking-mode requires ``reasoning_content``
                # on every assistant turn that participated in a tool
                # call — without it the next hop's request 400s with
                # "The reasoning_content in the thinking mode must be
                # passed back to the API." Always attach when we
                # captured any; ``provider.py`` strips it for non-
                # DeepSeek providers so this is harmless cross-
                # provider.
                if hop_reasoning:
                    assistant_tool_turn["reasoning_content"] = hop_reasoning
                running_history.append(assistant_tool_turn)

                tool_ctx = ToolContext(
                    db=db,
                    user=user,
                    conversation_id=conv.id,
                    user_message_id=triggering_user_msg_id,
                )
                async for sse_event, tool_history_msg in _dispatch_tools(
                    db=db,
                    request=request,
                    user=user,
                    pending_calls=pending_calls,
                    ctx=tool_ctx,
                    sse_yield=_sse,
                    on_attachment=assistant_attachment_snaps.append,
                    on_sources=sources_accumulator.extend,
                    on_cost=_record_tool_cost,
                    invocation_counts=tool_invocation_counts,
                    per_tool_caps=per_tool_caps,
                ):
                    # Always forward the SSE event. ``tool_history_msg``
                    # is None for "started" pre-events (which have no
                    # OpenAI counterpart); only "finished" events carry
                    # a history row to feed back to the next hop.
                    yield sse_event
                    if tool_history_msg is not None:
                        running_history.append(tool_history_msg)
            # NOTE: no ``for...else`` clause here on purpose. The
            # forced-finish hop's unconditional ``break`` above
            # guarantees we always exit via ``break``, so the
            # ``else`` branch was unreachable in practice and only
            # served to emit a misleading "couldn't finish within N
            # hops" error when what really happened was the model
            # returned text + extra tool_calls on the final hop.
            # The post-loop empty-text check below is the new home
            # for the "model did nothing useful" failure-mode chip;
            # it fires only when the bubble would otherwise be
            # genuinely empty after the model already burned through
            # at least one tool-call hop.
        except ProviderError as e:
            # Classify the error so the frontend can render an
            # actionable card (retry countdown, link to the upstream
            # settings page, "Pick another model" button, etc.) instead
            # of the raw upstream dump. Fallthrough is unclassified —
            # renders as a plain red banner exactly like before.
            classified = _classify_upstream_error(
                str(e),
                provider_type=provider.type,
                status_code=getattr(e, "status_code", None),
                retry_after=getattr(e, "retry_after", None),
            )
            # Log the classified category alongside provider/model/status
            # so error trends are visible in the logs (B3) — grep one
            # ``error_class=`` line to spot a flaky provider or a bad key.
            logger.warning(
                "Provider error on stream %s: error_class=%s provider=%s "
                "model=%s status=%s: %s",
                stream_id,
                (classified or {}).get("error_code", "unclassified"),
                provider.type,
                ctx.get("model_id"),
                getattr(e, "status_code", None),
                e,
            )
            if classified is not None:
                yield _sse({"error": str(e), **classified})
            else:
                yield _sse({"error": str(e)})
            yield _sse({"done": True})
            return
        except asyncio.CancelledError:
            logger.info("Stream %s cancelled", stream_id)
            raise

        stream_end = time.monotonic()
        ttft_ms = (
            int((first_token_at - stream_start) * 1000)
            if first_token_at is not None
            else None
        )
        total_ms = int((stream_end - stream_start) * 1000)

        # Persist the assistant message, including citations if we searched
        # and any attachments tools produced on this turn. Sources are
        # already deduped at the provider level, but we run a final
        # canonical-URL pass here too in case a single turn ran multiple
        # searches that happened to pull the same source.
        # Strip any leaked tool-call XML the model emitted as text instead
        # of a structured call. If this empties a reply that ran tools, the
        # synthesis-retry net just below regenerates a real answer.
        full = _strip_leaked_tool_call_xml("".join(collected_text))
        sources_payload: list[dict[str, Any]] | None = (
            _dedupe_sources(sources_accumulator) if sources_accumulator else None
        )

        # Post-loop synthesis-failure check. If the model burned tool
        # hops gathering information but never produced any visible
        # text, render an actionable error chip so the user
        # understands what happened — without this they'd just see an
        # empty bubble next to a row of tool chips, with no signal
        # that something went wrong. Only fires when sources or
        # attachments WERE collected (otherwise the empty bubble is
        # likely a benign "model said nothing" case worth keeping
        # quiet about, e.g. an immediately-cancelled turn).
        had_tool_activity = bool(sources_accumulator) or bool(
            assistant_attachment_snaps
        )
        if not full.strip() and had_tool_activity:
            # ---- Synthesis-retry pass ----
            # Truly model-agnostic safety net for the rare case where
            # the forced-finish hop still produced no text — usually
            # because the active model's OpenAI-compat layer
            # silently drops ``tool_choice="none"`` and pattern-matches
            # the long ``tool``/``tool_calls`` history into yet
            # another tool call. We give that model nothing to
            # pattern-match against: a clean prompt with the original
            # user question, a text digest of every tool result we
            # collected, no tools schema, no prior assistant
            # tool_call turns. There is literally nothing left to
            # call, so even the most stubborn model has to write
            # something.
            yield _sse({"event": "synthesis_retry"})
            logger.info(
                "Forced-finish hop produced no text; running "
                "synthesis-retry pass (stream=%s model=%s "
                "tool_results=%d)",
                stream_id,
                ctx["model_id"],
                sum(
                    1
                    for m in running_history
                    if isinstance(m, dict) and m.get("role") == "tool"
                ),
            )

            # Build a text digest from the tool messages we
            # accumulated. Each entry truncated to 2 000 chars to
            # keep the synthesis-prompt under control on chatty
            # tool outputs (web_search results in particular).
            tool_digest_parts: list[str] = []
            for msg in running_history:
                if not isinstance(msg, dict):
                    continue
                if msg.get("role") != "tool":
                    continue
                tname = msg.get("name", "tool")
                tcontent = msg.get("content", "")
                if isinstance(tcontent, list):
                    # Some providers return content as a parts array;
                    # flatten the text-typed parts only.
                    tcontent = "\n".join(
                        p.get("text", "")
                        for p in tcontent
                        if isinstance(p, dict) and p.get("type") == "text"
                    )
                if not isinstance(tcontent, str) or not tcontent:
                    continue
                truncated = tcontent[:2000] + (
                    "\n…[truncated]" if len(tcontent) > 2000 else ""
                )
                tool_digest_parts.append(f"--- {tname} ---\n{truncated}")
            tool_digest = (
                "\n\n".join(tool_digest_parts) or "(no tool output captured)"
            )

            # Reuse the user's most recent question as the only
            # message in the synthesis call. The system prompt carries
            # the research digest + the synthesis instruction. We
            # walk ``reversed(history_rows)`` to grab the latest user
            # turn — matching the existing pattern in this module
            # rather than the *first* user message in the conversation.
            synth_user_question = next(
                (
                    m.content
                    for m in reversed(history_rows)
                    if m.role == "user"
                ),
                "",
            )
            synth_system = (
                (system_prompt or "")
                + "\n\n[SYNTHESIS PASS] You previously researched the "
                + "user's question. Below is a digest of what the tool "
                + "calls returned. No tools are available now — write a "
                + "clear, concise final answer for the user using only "
                + "this research. If the research is incomplete, "
                + "acknowledge the gaps and answer with what you have.\n\n"
                + "=== RESEARCH DIGEST ===\n"
                + tool_digest
            )
            synth_messages: list[ChatMessage] = [
                ChatMessage(role="user", content=synth_user_question or "")
            ]

            retry_text_parts: list[str] = []
            try:
                async for ev in model_router.stream_chat_events(
                    provider=provider,
                    model_id=ctx["model_id"],
                    messages=synth_messages,
                    system=synth_system,
                    temperature=ctx["temperature"],
                    max_tokens=ctx["max_tokens"],
                    tools=None,
                    include_usage=False,
                    reasoning_effort=ctx.get("reasoning_effort"),
                ):
                    if isinstance(ev, TextDelta):
                        if first_token_at is None:
                            first_token_at = time.monotonic()
                        retry_text_parts.append(ev.text)
                        yield _sse({"delta": ev.text})
            except ProviderError as retry_err:
                # The retry itself failed upstream — fall through to
                # the final error chip below. Logged so an operator
                # can see both the original failure and the retry
                # failure side-by-side.
                logger.warning(
                    "Synthesis-retry pass failed (stream=%s model=%s): %s",
                    stream_id,
                    ctx["model_id"],
                    retry_err,
                )

            retry_text = "".join(retry_text_parts)
            if retry_text.strip():
                # Synthesis-retry succeeded; promote it to the final
                # ``full`` so the assistant message persists with the
                # synthesised answer instead of an empty string. Re-strip
                # so the earlier leaked XML (still in ``collected_text``)
                # doesn't ride along with the clean retry text.
                collected_text.append(retry_text)
                full = _strip_leaked_tool_call_xml("".join(collected_text))
            else:
                # Even the synthesis-retry produced nothing — surface
                # the actionable error chip as a last resort. The
                # bubble will still be empty but the user has a clear
                # signal something went wrong and a hint how to
                # retry.
                yield _sse(
                    {
                        "event": "tool_error",
                        "error": (
                            "The model ran tools but didn't synthesise a "
                            "reply, even on a clean retry. Try asking a "
                            "more focused question, or pick a different "
                            "model — this one is struggling with the "
                            "tool output."
                        ),
                    }
                )
        # Convert dollars to integer micros for the message column. We
        # keep ``cost_usd`` as a float locally (sums and SSE) and only
        # round at the persistence boundary.
        cost_micros: int | None = None
        if cost_usd is not None:
            cost_micros = max(0, int(round(cost_usd * 1_000_000)))

        reasoning_full = "".join(collected_reasoning) or None
        if continue_target is not None:
            # Continue-generation (Phase 3.1): append the freshly streamed
            # text onto the existing reply rather than creating a sibling.
            # ``full`` is the continuation only — the partial was injected
            # as prompt context, never into ``collected_text``. Tokens,
            # cost, and latency accumulate so the per-message stats stay
            # honest across both passes.
            assistant = continue_target
            assistant.content = (assistant.content or "") + full
            if reasoning_full:
                assistant.reasoning_content = (
                    (assistant.reasoning_content or "") + reasoning_full
                ) or None
            if sources_payload:
                merged_sources = list(assistant.sources or [])
                seen_urls = {
                    s.get("url")
                    for s in merged_sources
                    if isinstance(s, dict)
                }
                for s in sources_payload:
                    if isinstance(s, dict) and s.get("url") not in seen_urls:
                        merged_sources.append(s)
                        seen_urls.add(s.get("url"))
                assistant.sources = merged_sources
            if assistant_attachment_snaps:
                assistant.attachments = (
                    list(assistant.attachments or []) + assistant_attachment_snaps
                )
            assistant.prompt_tokens = (
                (assistant.prompt_tokens or 0) + (prompt_tokens or 0)
            ) or None
            assistant.completion_tokens = (
                (assistant.completion_tokens or 0) + (completion_tokens or 0)
            ) or None
            if total_ms is not None:
                assistant.total_ms = (assistant.total_ms or 0) + total_ms
            if cost_micros is not None:
                assistant.cost_usd_micros = (
                    assistant.cost_usd_micros or 0
                ) + cost_micros
            await db.flush()
            # Active leaf is unchanged (we extended the current reply).
            conv.active_leaf_message_id = assistant.id
            conv.updated_at = datetime.now(timezone.utc)
        else:
            assistant = Message(
                conversation_id=conv.id,
                role="assistant",
                content=full,
                # Phase 2.6 — hang the reply off the user turn that prompted
                # it. On a regenerate this makes the new answer a sibling of
                # the previous one (both share this parent), enabling the
                # ‹ 2/3 › version pager.
                parent_id=triggering_user_msg_id,
                # DeepSeek thinking-mode chain-of-thought. NULL on every
                # other provider; replayed back on follow-up turns to
                # avoid the "reasoning_content must be passed back" 400
                # the API throws on multi-turn tool-call conversations.
                reasoning_content=reasoning_full,
                sources=sources_payload,
                attachments=assistant_attachment_snaps or None,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                ttft_ms=ttft_ms,
                total_ms=total_ms,
                cost_usd_micros=cost_micros,
                # Stamp the exact model used for *this* turn (regenerate
                # builds a fresh ctx, so each version records its own).
                model_id=ctx["model_id"],
            )
            db.add(assistant)
            await db.flush()
            # This reply is now the visible leaf of the active path.
            conv.active_leaf_message_id = assistant.id
            conv.updated_at = datetime.now(timezone.utc)

        # Fold this turn's tokens into ``usage_daily`` in the *same*
        # transaction as the assistant message — either both land or
        # neither does, so the budget view never disagrees with what
        # the chat actually shows.
        try:
            await record_usage(
                db,
                user_id=user.id,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cost_usd=cost_usd,
            )
        except Exception:  # noqa: BLE001 — billing must never break the response
            logger.exception(
                "Failed to record usage for stream=%s user=%s", stream_id, user.id
            )

        await db.commit()
        await db.refresh(assistant)

        # Post-commit: snapshot the user's new spend posture and, if
        # they just crossed 80% of monthly, fire a one-shot warning
        # email to the admins. Wrapped in a broad except so an SMTP
        # outage can't tear down the SSE stream after the assistant
        # message is already on disk.
        try:
            snapshot = await check_budget(db, user)
            if snapshot.verdict == "warn":
                if await maybe_alert_admins(db, user=user, snapshot=snapshot):
                    await db.commit()
        except Exception:  # noqa: BLE001
            logger.exception(
                "Post-stream budget check failed for user=%s", user.id
            )

        # Phase P4 — opt-in rolling workspace memory. Fire-and-forget: the
        # task owns its own session, no-ops unless the workspace has
        # auto-memory enabled, and is debounced per workspace. Gated on
        # ``workspace_id`` so non-workspace chats spawn nothing.
        if conv.workspace_id is not None:
            from app.workspaces.knowledge import maybe_refresh_workspace_memory

            asyncio.create_task(maybe_refresh_workspace_memory(conv.id))

            # Opt-in chat-as-context (0090): keep the embedded transcript
            # fresh as the chat grows, but only for chats the user has
            # explicitly turned ON. No-op (cheap hash skip) otherwise.
            if getattr(conv, "context_enabled", False):
                from app.workspaces.knowledge import index_chat_for_workspace

                asyncio.create_task(
                    index_chat_for_workspace(conv.workspace_id, conv.id)
                )

        # Phase 6 — cross-chat memory capture. Cheap regex pre-filter so
        # ordinary turns cost nothing; when the user states something
        # durable (or says "remember…"), run a bounded headless extraction
        # and persist any genuinely new facts. Surfaced via a
        # ``memory_saved`` event just before ``done`` so the UI can show a
        # "saved to memory" affordance. Best-effort — a failure here never
        # disturbs the reply that's already on disk.
        # capture_memories now returns list[dict] with {"id", "content"}
        # so the UI can undo individual facts by id (Phase 2.2).
        memory_saved: list[dict] = []
        if (
            # Auto-capture only in "auto" mode; "manual" injects saved
            # facts but never volunteers new ones.
            memory_mode == "auto"
            # Phase 9 — per-conversation pause skips capture while still
            # injecting previously-saved memories.
            and not conv.memory_capture_paused
            and trig_row is not None
            and (trig_row.content or "").strip()
            and should_attempt_capture(trig_row.content)
        ):
            try:
                memory_saved = await capture_memories(
                    db,
                    user_id=user.id,
                    user_text=trig_row.content,
                    assistant_text=full,
                    source_conversation_id=conv.id,
                    provider=provider,
                    model_id=ctx["model_id"],
                )
                if memory_saved:
                    await db.commit()
            except Exception:  # noqa: BLE001
                logger.exception("Memory capture failed for user=%s", user.id)
                memory_saved = []
        if memory_saved:
            yield _sse(
                {
                    "event": "memory_saved",
                    "facts": [m["content"] for m in memory_saved],
                    "ids": [m["id"] for m in memory_saved],
                    "count": len(memory_saved),
                }
            )

        # Auto-title the conversation after the first successful exchange.
        # Anything the user has already renamed is left untouched.
        #
        # A second, one-shot pass re-titles once the chat has more shape
        # (~5 messages): the opening title is generated off a single
        # exchange and is often vague, so we sharpen it from a transcript
        # digest once there's real context. ``title_refined`` guards it so
        # it never re-titles on every subsequent turn.
        total_messages = len(history_rows) + 1  # + the reply just saved
        should_refine = (
            not is_first_turn
            and not conv.title_manually_set
            and not conv.title_refined
            and total_messages >= 5
        )
        if is_first_turn and not conv.title_manually_set:
            try:
                new_title = await generate_conversation_title(
                    user_message=first_user_message,
                    assistant_message=full,
                    llm_provider=provider,
                    llm_model_id=ctx["model_id"],
                )
            except Exception:  # pragma: no cover
                logger.exception("Titler crashed; keeping provisional title")
                new_title = ""
            if new_title and new_title != conv.title:
                conv.title = new_title
                await db.commit()
                yield _sse({"event": "title_updated", "title": new_title})
        elif should_refine:
            # Build a compact transcript so the titler sees the whole
            # thread, not just the opening line. The titler truncates to
            # its own source-char cap, so this stays bounded.
            transcript = "\n".join(
                f"{m.role}: {(m.content or '').strip()}"
                for m in history_rows
                if m.role in ("user", "assistant") and (m.content or "").strip()
            )
            conv.title_refined = True
            try:
                new_title = await generate_conversation_title(
                    user_message=transcript or first_user_message,
                    assistant_message=full,
                    llm_provider=provider,
                    llm_model_id=ctx["model_id"],
                )
            except Exception:  # pragma: no cover
                logger.exception("Title refine crashed; keeping title")
                new_title = ""
            # Persist the ``title_refined`` flag regardless, so a failed
            # refine doesn't retry every turn.
            if new_title and new_title != conv.title:
                conv.title = new_title
                await db.commit()
                yield _sse({"event": "title_updated", "title": new_title})
            else:
                await db.commit()

        yield _sse(
            {
                "done": True,
                "message_id": str(assistant.id),
                "created_at": assistant.created_at.isoformat(),
                "sources": sources_payload,
                "attachments": assistant_attachment_snaps or None,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "ttft_ms": ttft_ms,
                "total_ms": total_ms,
                # The model that produced this reply, so the version pager
                # can show it without waiting for a reload.
                "model_id": ctx["model_id"],
                # Per-message dollar cost (provider completion + any
                # paid tools that ran on this turn). Floats are fine
                # over the wire — micros stays a server-side detail.
                "cost_usd": cost_usd,
                # The upstream stopped because it hit the output-token
                # ceiling rather than finishing naturally — the reply is
                # cut off mid-thought. Surface it so the UI can show a
                # "response was truncated" hint + a regenerate nudge.
                # ``hop_finish`` retains the final hop's finish_reason
                # after the loop breaks.
                "truncated": hop_finish == "length",
            }
        )


async def _bridge_generator_to_session(
    stream_id: uuid.UUID,
    user: User,
    request: Request,
    session: StreamSession,
) -> None:
    """Pump every chunk from the SSE generator into the session buffer.

    The session is what subscribers (the HTTP handler) read from, so the
    HTTP connection going away no longer aborts generation. Runs once
    per stream; ``get_or_create_session`` enforces the singleton.
    """
    async for chunk in _stream_generator(stream_id, user, request):
        session.push(chunk)


async def _subscribe_session_to_response(
    session: StreamSession, request: Request
) -> AsyncGenerator[str, None]:
    """Forward buffered + future events to one HTTP client.

    Cancellation here (client disconnect) is intentional — we just stop
    forwarding. The background task keeps running in the session and
    will persist the assistant message regardless. A reconnect within
    ``COMPLETED_SESSION_TTL_SECONDS`` replays the full transcript from
    index 0 because we can't depend on the client preserving cursors
    across navigations.
    """
    try:
        async for _idx, chunk in session.subscribe(from_index=0):
            yield chunk
            # Cooperative disconnect check — if the client is gone we
            # stop forwarding immediately rather than queueing chunks
            # the ASGI server can't deliver. The runner doesn't care.
            if await request.is_disconnected():
                logger.debug(
                    "SSE subscriber disconnected for stream %s; runner continues",
                    session.stream_id,
                )
                return
    except asyncio.CancelledError:
        # The starlette/ASGI layer cancels us when the client drops.
        # Swallow it — the underlying generation lives in its own task.
        return


@router.get("/stream/{stream_id}")
async def stream_response(
    stream_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    # First call: peek at the queued context so we can index the session
    # by conversation id (needed for ``find_active_for_conversation``).
    # Reconnects skip the peek — the in-memory session already has it.
    existing = get_session(stream_id)
    if existing is None:
        ctx = await peek_stream(stream_id)
        if ctx is None:
            # Either the context expired (client took >60s to attach) or
            # this id was already consumed and the session has been
            # evicted. Surface a one-shot SSE error so the frontend
            # shows a message instead of hanging.
            async def _missing() -> AsyncGenerator[str, None]:
                yield _sse({"error": "Stream not found or expired"})
                yield _sse({"done": True})

            return StreamingResponse(
                _missing(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )
        conversation_id = uuid.UUID(ctx["conversation_id"])
    else:
        conversation_id = existing.conversation_id

    session = await get_or_create_session(
        stream_id=stream_id,
        user_id=user.id,
        conversation_id=conversation_id,
        runner=lambda s: _bridge_generator_to_session(stream_id, user, request, s),
    )

    return StreamingResponse(
        _subscribe_session_to_response(session, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Nginx needs this to stop buffering the body for SSE. Our own
            # nginx.conf already disables proxy_buffering but this header is
            # idiomatic and defensive against other reverse proxies.
            "X-Accel-Buffering": "no",
        },
    )


_ALLOWED_EXPORT_FORMATS = {"markdown", "json", "pdf"}


def _content_disposition(filename: str) -> str:
    """Build a ``Content-Disposition: attachment`` header value that
    survives non-ASCII titles by emitting both a plain ASCII fallback
    and an RFC 5987 ``filename*`` parameter. Matches the approach the
    files router uses for user uploads."""
    from urllib.parse import quote as _urlquote

    # Replace any non-ASCII/unsafe char in the fallback with ``_`` so
    # ancient clients still save the file with *some* name.
    ascii_name = "".join(
        c if (32 <= ord(c) < 127 and c != '"') else "_" for c in filename
    )
    utf8_name = _urlquote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"


@router.get("/conversations/{conversation_id}/export")
async def export_conversation(
    conversation_id: uuid.UUID,
    request: Request,
    fmt: str = Query(
        "markdown",
        pattern="^(markdown|json|pdf)$",
        description="Export format: markdown (default), json, or pdf.",
    ),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Download a persisted conversation in the requested format.

    Access control is the same as :func:`get_conversation` — owners and
    accepted collaborators can export; everyone else gets a 404. System
    rows are excluded from the Markdown/PDF transcripts (they're
    implementation detail) but preserved in the JSON payload for
    round-trip fidelity with the importer.

    The endpoint returns a streaming :class:`Response` directly rather
    than a Pydantic model because the three formats need three
    different ``Content-Type`` + ``Content-Disposition`` pairs. Large
    PDFs are rendered off-thread via :func:`asyncio.to_thread` so the
    event loop keeps serving other requests while xhtml2pdf typesets.
    """
    if fmt not in _ALLOWED_EXPORT_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown export format: {fmt}",
        )

    conv, _role = await get_accessible_conversation(conversation_id, user, db)

    # Pull every persisted message in chronological order. No pagination:
    # the largest conversations we support still comfortably fit in
    # memory, and a partial export would produce a confusing artifact.
    msgs_q = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv.id)
        .order_by(Message.created_at.asc(), Message.id.asc())
    )
    messages = list(msgs_q.scalars().all())

    # Audit: lets admins see export activity in the same timeline as
    # other sensitive actions (budget bumps, MFA changes). Kept
    # best-effort — the export itself succeeds even if the audit
    # write hiccups.
    try:
        await record_event(
            db,
            request=request,
            user_id=user.id,
            event_type="conversation.exported",
            identifier=user.username,
            detail=safe_dict(
                {
                    "conversation_id": str(conv.id),
                    "format": fmt,
                    "message_count": len(messages),
                }
            ),
        )
    except Exception:  # pragma: no cover — audit is never critical path
        logging.getLogger("promptly.chat.export").warning(
            "audit-write-failed", exc_info=True
        )

    from app.chat.export import (
        render_conversation_json_bytes,
        render_conversation_markdown,
        render_conversation_pdf,
        safe_export_filename,
    )

    filename = safe_export_filename(conv, fmt)
    headers = {"Content-Disposition": _content_disposition(filename)}

    if fmt == "markdown":
        body = render_conversation_markdown(conv, messages).encode("utf-8")
        return Response(
            content=body,
            media_type="text/markdown; charset=utf-8",
            headers=headers,
        )
    if fmt == "json":
        body = render_conversation_json_bytes(conv, messages)
        return Response(
            content=body,
            media_type="application/json",
            headers=headers,
        )
    # fmt == "pdf"
    try:
        body = await asyncio.to_thread(
            render_conversation_pdf, conv, messages
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"PDF rendering failed: {exc}",
        ) from exc
    return Response(
        content=body,
        media_type="application/pdf",
        headers=headers,
    )


# ---------------------------------------------------------------------
# Import — accept an upload, parse it into ParsedConversation records,
# materialise each as a Conversation + Messages pair under the caller.
# ---------------------------------------------------------------------


# Hard cap on a single import payload. Prevents a runaway file from
# DoSing the JSON parser / zip walker; comfortably large enough for a
# full ChatGPT account export, which usually tops out around 50 MB.
_IMPORT_MAX_BYTES = 100 * 1024 * 1024  # 100 MB

# Hard cap on number of messages we'll materialise from a single
# imported conversation. Guards against pathological exports; real
# chats very rarely exceed a few hundred turns.
_IMPORT_MAX_MESSAGES_PER_CONV = 5000


@router.post("/conversations/import", status_code=status.HTTP_201_CREATED)
async def import_conversations(
    file: UploadFile = File(...),
    workspace_id: uuid.UUID | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Import chats from a Promptly / ChatGPT / Claude / Markdown file.

    Accepts bulk uploads (ChatGPT exports commonly contain hundreds of
    conversations in a single ``conversations.json``). Each parsed
    conversation becomes a fresh :class:`Conversation` row owned by
    the caller; the original message timestamps are preserved when
    the source provided them so imported chats land in the right
    history buckets on the sidebar.

    Optional ``workspace_id`` form field drops every imported
    conversation into the named workspace — a shortcut for "migrate
    everything from ChatGPT into this one workspace". Rejected if the
    workspace belongs to someone else or doesn't exist.
    """
    from app.chat import import_ as importer

    data = await file.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )
    if len(data) > _IMPORT_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"Uploaded file is too large "
                f"(max {_IMPORT_MAX_BYTES // (1024 * 1024)} MB)."
            ),
        )

    # Optional workspace target.
    workspace_row: Workspace | None = None
    if workspace_id is not None:
        workspace_row = await db.get(Workspace, workspace_id)
        if workspace_row is None or workspace_row.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown workspace",
            )

    try:
        parsed_list = importer.parse_upload(
            filename=file.filename or "",
            content_type=file.content_type,
            data=data,
        )
    except importer.ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    if not parsed_list:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No conversations could be parsed from the upload.",
        )

    created: list[dict[str, Any]] = []
    skipped: int = 0
    total_messages: int = 0
    now = datetime.now(timezone.utc)

    for parsed in parsed_list:
        # Skip empty shells — importing a chat with zero turns would
        # create a stub row the user has to go clean up later.
        if not parsed.messages:
            skipped += 1
            continue

        title = importer.synthesise_title(parsed)

        conv = Conversation(
            user_id=user.id,
            title=title,
            # We *don't* carry over the source's model/provider — those
            # IDs wouldn't be valid on this install. Leaving them NULL
            # makes the imported chat inherit the user's current
            # selection on the next send.
            model_id=None,
            provider_id=None,
            web_search_mode="off",
            workspace_id=workspace_row.id if workspace_row else None,
        )
        # Preserve original created_at when the parser surfaced one —
        # keeps date-group bucketing ("Last week", "April 2025", ...)
        # accurate on the sidebar instead of dumping everything under
        # "Today".
        if parsed.created_at is not None:
            conv.created_at = parsed.created_at
            conv.updated_at = parsed.created_at
        db.add(conv)
        # Flush so ``conv.id`` is populated before we start attaching
        # messages; a single explicit flush per conversation is cheap
        # and avoids relying on SQLAlchemy's autoflush heuristics.
        await db.flush()

        count = 0
        prev_msg_id: uuid.UUID | None = None
        for msg in parsed.messages[:_IMPORT_MAX_MESSAGES_PER_CONV]:
            m = Message(
                conversation_id=conv.id,
                role=msg.role,
                content=msg.content,
                sources=msg.sources,
                # Phase 2.6 — rebuild a linear lineage on import so the
                # active-path walk + version metadata stay coherent.
                parent_id=prev_msg_id,
                # Attachments carried on the imported rows are
                # *snapshots* from a different install — the file
                # ids inside won't resolve to anything in this
                # user's library. We keep them for archival
                # purposes so the original filenames still show
                # up as chips, but the backend won't try to
                # re-feed their bytes on the next send.
                attachments=msg.attachments,
            )
            if msg.created_at is not None:
                m.created_at = msg.created_at
            db.add(m)
            await db.flush()
            prev_msg_id = m.id
            count += 1
        total_messages += count
        # The last imported message is the active leaf.
        conv.active_leaf_message_id = prev_msg_id

        # Tag latest activity so history-grouping sorts correctly.
        if parsed.messages and parsed.messages[-1].created_at:
            conv.updated_at = parsed.messages[-1].created_at
        elif parsed.created_at is None:
            conv.updated_at = now

        created.append(
            {
                "id": str(conv.id),
                "title": title,
                "message_count": count,
                "source": parsed.source_format,
            }
        )

    await db.commit()

    try:
        await record_event(
            db=db,
            event_type="conversations.imported",
            identifier=user.username,
            detail=safe_dict(
                {
                    "count": len(created),
                    "skipped": skipped,
                    "total_messages": total_messages,
                    "workspace_id": str(workspace_row.id) if workspace_row else None,
                    "filename": file.filename,
                }
            ),
        )
    except Exception:  # pragma: no cover — audit is never critical path
        logging.getLogger("promptly.chat.import").warning(
            "audit-write-failed", exc_info=True
        )

    # Fire-and-forget push so a big ChatGPT account export can be
    # kicked off, the user can switch tabs, and they get a ping when
    # it's done. Skipped silently when VAPID isn't configured.
    if created:
        try:
            from app.notifications import notify_user

            target_url = (
                f"/projects/{project_row.id}" if project_row else "/chat"
            )
            await notify_user(
                user_id=user.id,
                category="import_done",
                title="Import complete",
                body=(
                    f"{len(created)} conversation"
                    f"{'s' if len(created) != 1 else ''} imported "
                    f"({total_messages} message"
                    f"{'s' if total_messages != 1 else ''})."
                ),
                url=target_url,
                tag="promptly-import",
            )
        except Exception:  # pragma: no cover — push is never critical
            logging.getLogger("promptly.chat.import").warning(
                "push-dispatch-failed", exc_info=True
            )

    return {
        "imported": len(created),
        "skipped": skipped,
        "total_messages": total_messages,
        "conversations": created,
    }


@router.get("/conversations/{conversation_id}/active-stream")
async def get_active_stream(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str | None]:
    """Tell the client whether a generation is in flight for this convo.

    Called when the conversation page mounts. If a stream is found, the
    frontend reattaches to it (replays buffered tokens + tails the live
    feed) instead of leaving the user staring at the persisted-but-stale
    transcript while the AI is still talking in the background.
    """
    # Membership check piggy-backs on the existing share helper so the
    # caller can see streams for shared conversations they have access
    # to, not just their own. Raises 404 itself if the user can't see it.
    await get_accessible_conversation(conversation_id, user, db)
    session = find_active_for_conversation(conversation_id=conversation_id)
    return {"stream_id": str(session.stream_id) if session else None}


# Keep the scaffold ping for sanity checks.
@router.get("/_ping")
async def ping() -> dict[str, str]:
    return {"module": "chat", "status": "ready"}

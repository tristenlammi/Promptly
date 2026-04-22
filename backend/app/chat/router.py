"""Chat API — conversations CRUD, send message, SSE streaming."""
from __future__ import annotations

import asyncio
import json
import logging
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
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

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
    ChatProject,
    ChatProjectFile,
    CompareGroup,
    Conversation,
    ConversationShare,
    Message,
)
from app.chat.schemas import (
    BranchConversationRequest,
    CompactionResponse,
    ConversationCreate,
    ConversationDetail,
    ConversationSearchHit,
    ConversationSummary,
    ConversationUpdate,
    EditMessageRequest,
    MessageResponse,
    RegenerateMessageRequest,
    SendMessageRequest,
    SendMessageResponse,
)
from app.chat.compaction import CompactionError, compact_conversation
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
from app.chat.titler import fallback_title, generate_conversation_title
from app.chat.tools import (
    ToolContext,
    ToolError,
    build_tools_system_prompt,
    get_tool,
    list_openai_tools,
)
from app.database import SessionLocal, get_db
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
    TextDelta,
    TextPart,
    ToolCallDelta,
    UsageEvent,
    model_router,
)
from app.rate_limit import enforce_user_message_rate
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
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
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

    Only the caller's own conversations are searched today; once
    Phase 4b lands, this widens to include conversations they
    collaborate on via ``conversation_shares``.
    """
    cleaned = _to_websearch_query(q)
    if not cleaned:
        return []

    # Phase 4b — search across owned chats *and* accepted shares.
    # Pre-resolving the id list keeps the FTS query simple and lets
    # Postgres reuse the GIN index without a wider join.
    accessible_ids = await list_accessible_conversation_ids(user, db)
    if not accessible_ids:
        return []

    sql = text(
        """
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
          AND m.content_tsv @@ websearch_to_tsquery('english', :q)
        ORDER BY rank DESC, m.created_at DESC
        LIMIT :limit
        """
    )
    rows = (
        await db.execute(
            sql,
            {
                "q": cleaned,
                "conv_ids": accessible_ids,
                "limit": limit,
                "user_id": user.id,
            },
        )
    ).mappings().all()

    return [
        ConversationSearchHit(
            conversation_id=r["conversation_id"],
            message_id=r["message_id"],
            conversation_title=r["conversation_title"],
            role=r["role"],
            snippet=str(r["snippet"] or ""),
            rank=float(r["rank"] or 0.0),
            created_at=r["created_at"],
            access=r["access"],
        )
        for r in rows
    ]


@router.get("/conversations", response_model=list[ConversationSummary])
async def list_conversations(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationSummary]:
    """List conversations the caller can read (owned + accepted shares).

    Phase 4b widened this to include accepted shares: an outer join
    against ``conversation_shares`` lets a single ORDER BY drive
    pagination across both relationship types. The ``role`` column
    on the response is stamped from whether the share row matched —
    drives the "Shared" sidebar pill without a follow-up request.
    """
    accepted_share = (
        select(ConversationShare.conversation_id)
        .where(
            ConversationShare.invitee_user_id == user.id,
            ConversationShare.status == "accepted",
        )
        .subquery()
    )

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

    result = await db.execute(
        select(Conversation)
        .outerjoin(
            accepted_share,
            accepted_share.c.conversation_id == Conversation.id,
        )
        .where(
            (Conversation.user_id == user.id)
            | (accepted_share.c.conversation_id.is_not(None))
        )
        .where(
            (Conversation.temporary_mode.is_(None))
            | (Conversation.temporary_mode == "one_hour")
        )
        .where(
            (Conversation.expires_at.is_(None))
            | (Conversation.expires_at > now)
        )
        .where(Conversation.id.not_in(select(non_crowned_compare)))
        .order_by(Conversation.pinned.desc(), Conversation.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    out: list[ConversationSummary] = []
    for c in result.scalars().all():
        summary = ConversationSummary.model_validate(c)
        summary.role = "owner" if c.user_id == user.id else "collaborator"
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

    # Phase P1 — validate the requested project (if any). Ownership
    # is enforced here (not just on the projects endpoints) so a user
    # can't drop a chat into someone else's project via the create
    # payload; temporary + project is rejected because the sweeper
    # would otherwise need to think about cascading behaviour.
    project_id: uuid.UUID | None = None
    if payload.project_id is not None:
        if payload.temporary_mode is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Temporary chats can't belong to a project.",
            )
        project = await db.get(ChatProject, payload.project_id)
        if project is None or project.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown project",
            )
        project_id = project.id
        # If the conversation didn't pick a model explicitly, inherit
        # the project's defaults — matches ChatGPT's behaviour where
        # opening a project-new-chat uses the project-level model.
        if payload.model_id is None and project.default_model_id:
            payload = payload.model_copy(
                update={"model_id": project.default_model_id}
            )
        if payload.provider_id is None and project.default_provider_id:
            payload = payload.model_copy(
                update={"provider_id": project.default_provider_id}
            )

    conv = Conversation(
        user_id=user.id,
        title=payload.title,
        model_id=payload.model_id,
        provider_id=payload.provider_id,
        web_search_mode=payload.web_search_mode,
        temporary_mode=payload.temporary_mode,
        expires_at=expires_at,
        project_id=project_id,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationDetail:
    conv, role = await get_accessible_conversation(conversation_id, user, db)
    messages_result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv.id)
        .order_by(Message.created_at.asc())
    )
    messages = [
        MessageResponse.model_validate(m) for m in messages_result.scalars().all()
    ]
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
    if payload.model_id is not None:
        conv.model_id = payload.model_id
    if payload.provider_id is not None:
        conv.provider_id = payload.provider_id
    # Phase P1 — project reassignment. Only honour the field when the
    # client explicitly sent it (``model_fields_set`` check) so this
    # PATCH stays idempotent for the common "just toggle pinned"
    # case. Temporary chats can't be projectised — same reasoning as
    # in :func:`create_conversation`.
    if "project_id" in payload.model_fields_set:
        if payload.project_id is None:
            conv.project_id = None
        else:
            if conv.temporary_mode is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Temporary chats can't belong to a project.",
                )
            project = await db.get(ChatProject, payload.project_id)
            if project is None or project.user_id != user.id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Unknown project",
                )
            conv.project_id = project.id

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
    branch_title = f"Branch: {base_title}"[:255]

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
    )
    db.add(branch)
    await db.flush()  # need branch.id for the message rows

    # Copy each message verbatim. We deliberately preserve metrics
    # (token counts, ttft, cost) so the branch's history matches
    # what the user actually saw when they forked. New turns posted
    # after the fork are billed normally to whoever sends them.
    for src_msg in history:
        db.add(
            Message(
                conversation_id=branch.id,
                role=src_msg.role,
                content=src_msg.content,
                sources=src_msg.sources,
                whiteboard_actions=src_msg.whiteboard_actions,
                attachments=src_msg.attachments,
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
        )

    await db.commit()
    await db.refresh(branch)

    summary = ConversationSummary.model_validate(branch)
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
    conv = await _get_owned_conversation(conversation_id, user, db)
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
    # Phase 4b — collaborators can post into shared chats. The cost
    # rolls onto whoever is authenticated here (``user``) because
    # ``record_usage`` keys on the sender, exactly the "sender pays"
    # behaviour the product wants.
    conv, _role = await get_accessible_conversation(conversation_id, user, db)

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

    # Enforce per-user model allowlist for non-admins. None = unrestricted.
    if user.role != "admin" and user.allowed_models is not None:
        if model_id not in set(user.allowed_models):
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
    user_msg = Message(
        conversation_id=conv.id,
        role="user",
        content=payload.content,
        attachments=attachment_snapshots,
        # Phase 4b — record who actually sent the turn so the UI can
        # render "from Jane" chips on shared chats.
        author_user_id=user.id,
    )
    db.add(user_msg)

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
    * The message must be the *most recent* user message in the
      conversation. Editing arbitrarily-old user turns would orphan or
      contradict every assistant reply that came after, which is more
      mess than we want to support today.

    Side effects on success:

    * ``messages.content`` is overwritten in place. Attachments are
      preserved — the user is editing text, not files.
    * Every message strictly *after* the edited one is hard-deleted
      (typically just one assistant reply, but we tolerate any tail in
      case streams ever produce siblings).
    * A fresh stream is enqueued with the same shape ``send_message``
      uses, so the existing SSE pipeline drives the regeneration. The
      response body is byte-identical to ``send_message``'s so the
      frontend can reuse its streaming hook unchanged.
    """
    # Quota gates apply to every regenerate too — otherwise the
    # easiest way around a budget cap is to spam the "edit" button.
    await _enforce_send_quotas(request, user, db)
    # Phase 4b — collaborators can edit their *own* prior messages
    # in a shared chat (defended by the author check below). They
    # can't edit the other party's turns; that would silently
    # rewrite their words on the page.
    conv, _role = await get_accessible_conversation(conversation_id, user, db)

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

    # Confirm this is the conversation's last user message. Anything
    # newer than `target.created_at` must therefore be assistant /
    # system rows produced in response to it — those get cleared below.
    last_user_q = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv.id, Message.role == "user")
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    last_user = last_user_q.scalars().first()
    if last_user is None or last_user.id != target.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Only the most recent user message can be edited. Send a "
                "new message instead."
            ),
        )

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
    if user.role != "admin" and user.allowed_models is not None:
        if model_id not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    # Rewrite the user message in place. Don't touch attachments — the
    # snapshot stays valid and the stream re-resolves them by id.
    target.content = payload.content

    # Drop everything that came strictly after this user turn. In normal
    # flows that's exactly one assistant reply; we tolerate more in case
    # interrupted streams or future features ever leave siblings behind.
    delete_after_q = await db.execute(
        select(Message)
        .where(
            Message.conversation_id == conv.id,
            Message.created_at > target.created_at,
        )
    )
    for stale in delete_after_q.scalars().all():
        await db.delete(stale)

    # Update conv defaults so the next plain ``send_message`` works
    # without re-specifying — same behavior as send_message.
    conv.model_id = model_id
    conv.provider_id = provider_id
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(target)

    effective_mode = (
        payload.web_search_mode
        if payload.web_search_mode is not None
        else (conv.web_search_mode or "off")
    )
    stream_id = uuid.uuid4()
    ctx: StreamContext = {
        "conversation_id": str(conv.id),
        "user_message_id": str(target.id),
        "provider_id": str(provider_id),
        "model_id": model_id,
        "web_search_mode": effective_mode,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "tools_enabled": bool(payload.tools_enabled),
    }
    await enqueue_stream(stream_id, ctx)

    return SendMessageResponse(
        stream_id=stream_id,
        user_message=MessageResponse.model_validate(target),
    )


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
    * It must be the *most recent* assistant message. Regenerating an
      older assistant turn would orphan every reply that followed — same
      reason :func:`edit_and_resend_message` pins to the last user turn.
    * A preceding user message must exist; regenerating an assistant
      message with no prompt would just re-emit the system preamble.

    Side effects on success:

    * The target assistant message (and anything strictly newer, e.g.
      tool-invocation sidecars produced mid-stream) is hard-deleted.
    * The preceding user message is left untouched.
    * A fresh stream is enqueued against the same user message. Callers
      may override ``provider_id`` / ``model_id`` to power the "try a
      different model" button; omitting them regenerates with the
      conversation's existing defaults.

    The response shape matches ``send_message`` and ``edit_and_resend``
    so the frontend streaming hook stays unchanged — we just hand back
    the *preceding user message* in ``user_message`` because that's what
    the stream is being driven from.
    """
    # Same quota treatment as edit — otherwise "regenerate" becomes a
    # budget escape hatch.
    await _enforce_send_quotas(request, user, db)
    conv, _role = await get_accessible_conversation(conversation_id, user, db)

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

    # Confirm it's the latest assistant turn. Regenerating mid-history
    # would contradict / orphan everything that followed.
    last_assistant_q = await db.execute(
        select(Message)
        .where(
            Message.conversation_id == conv.id,
            Message.role == "assistant",
        )
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    last_assistant = last_assistant_q.scalars().first()
    if last_assistant is None or last_assistant.id != target.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Only the most recent assistant reply can be regenerated. "
                "Branch the conversation if you want to retry earlier."
            ),
        )

    # Find the user message that prompted this reply. With our current
    # schema that's simply "the newest user message older than target";
    # branching guarantees each assistant reply has exactly one ancestor.
    prompt_q = await db.execute(
        select(Message)
        .where(
            Message.conversation_id == conv.id,
            Message.role == "user",
            Message.created_at < target.created_at,
        )
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    prompt = prompt_q.scalars().first()
    if prompt is None:
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
    if user.role != "admin" and user.allowed_models is not None:
        if model_id not in set(user.allowed_models):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )

    # Wipe the target assistant reply plus any newer rows (tool sidecars,
    # interrupted-stream scraps). The preceding user turn is preserved
    # verbatim so re-streaming is bit-for-bit identical on the prompt
    # side.
    delete_after_q = await db.execute(
        select(Message)
        .where(
            Message.conversation_id == conv.id,
            Message.created_at >= target.created_at,
        )
    )
    for stale in delete_after_q.scalars().all():
        await db.delete(stale)

    # Persist any model override onto the conversation so the next plain
    # send picks up the choice, mirroring send_message/edit semantics.
    conv.model_id = model_id
    conv.provider_id = provider_id
    if payload.web_search_mode is not None:
        conv.web_search_mode = payload.web_search_mode
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(prompt)

    effective_mode = (
        payload.web_search_mode
        if payload.web_search_mode is not None
        else (conv.web_search_mode or "off")
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
    }
    await enqueue_stream(stream_id, ctx)

    return SendMessageResponse(
        stream_id=stream_id,
        user_message=MessageResponse.model_validate(prompt),
    )


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


# ====================================================================
# SSE stream
# ====================================================================
def _sse(data: dict) -> str:
    """Format a dict as a single SSE `data:` event."""
    return f"data: {json.dumps(data)}\n\n"


def _classify_upstream_error(
    message: str, *, provider_type: str
) -> dict[str, Any] | None:
    """Classify a ``ProviderError`` message into a structured error.

    Returns ``None`` for unclassified errors (caller renders the raw
    message as before). A non-None return is a dict of extra SSE
    fields — ``error_code`` + optional ``error_help_url`` +
    ``error_title`` — that the frontend uses to pick a richer error
    card (links, buttons, tone) instead of the default red banner.

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

    return None


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
# wall-clock time. Five is enough headroom for a tool that needs to
# call a follow-up tool to refine its output, while still capping total
# cost at a predictable multiple of a single chat turn.
MAX_TOOL_HOPS = 5


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

        # 3) Per-turn cap (e.g. generate_image budget). Counted before
        #    the call so a refusal still bumps the counter — the model
        #    can't get around the cap by spamming retries.
        if tool.max_per_turn is not None and invocation_counts is not None:
            spent = invocation_counts.get(name, 0)
            if spent >= tool.max_per_turn:
                err_msg = (
                    f"Tool '{name}' is limited to {tool.max_per_turn} "
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

        # Build message history from DB (ordered).
        messages_result = await db.execute(
            select(Message)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.created_at.asc())
        )
        history_rows = messages_result.scalars().all()

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

        # Phase P1 — Chat Projects. When the conversation belongs to a
        # project, fold its pinned files into the *triggering* turn's
        # attachment list so they flow through the existing
        # ``build_attachment_preamble`` / vision pipeline without any
        # duplicate plumbing. The project's ``system_prompt`` is
        # handled later (see ``project_system_prompt`` below) where it
        # slots in alongside the tools-aware and personal-context
        # prompts.
        project_system_prompt: str | None = None
        if conv.project_id is not None:
            project_row = await db.get(ChatProject, conv.project_id)
            if project_row is not None and project_row.user_id == user.id:
                project_system_prompt = (
                    project_row.system_prompt.strip()
                    if project_row.system_prompt
                    else None
                ) or None

                pin_rows = await db.execute(
                    select(UserFile)
                    .join(
                        ChatProjectFile,
                        ChatProjectFile.file_id == UserFile.id,
                    )
                    .where(ChatProjectFile.project_id == project_row.id)
                    .order_by(ChatProjectFile.pinned_at.asc())
                )
                pinned_files = list(pin_rows.scalars().all())
                # ACL: only honour files the caller still owns. Files
                # shared with them via the admin pool are fair game
                # too (``user_id is None``) — same rule as
                # ``_load_message_attachments``.
                pinned_files = [
                    f for f in pinned_files
                    if f.user_id is None or f.user_id == user.id
                ]
                if pinned_files:
                    existing = per_message_attachments.get(
                        triggering_user_msg_id, []
                    )
                    existing_ids = {f.id for f in existing}
                    # Prepend so project pins render first in the
                    # preamble ("Project files: ..." reads naturally
                    # before "this turn's attachments: ..."). Skip
                    # any file the user *also* attached to this very
                    # turn to avoid duplicated text blobs.
                    merged = [
                        f for f in pinned_files if f.id not in existing_ids
                    ] + list(existing)
                    per_message_attachments[triggering_user_msg_id] = merged

        # Surface vision warnings to the client. We only warn for the
        # *triggering* turn — older turns with images already produced
        # a reply, the user has long since seen the consequence.
        triggering_warnings: list[str] = []
        triggering_files = per_message_attachments.get(triggering_user_msg_id, [])
        if triggering_files:
            has_image = any(looks_image(f) for f in triggering_files)
            if has_image and not model_supports_vision:
                triggering_warnings.append(
                    f"The selected model ({ctx['model_id']}) cannot read "
                    "images. Image attachments will be acknowledged by "
                    "filename but their visual contents won't be sent. "
                    "Pick a vision-capable model to have the AI actually "
                    "see them."
                )

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
                    attachments, vision_handles_images=model_supports_vision
                )
            else:
                preamble = ""

            full_text = preamble + base_text

            # Image bytes: re-fed on EVERY user turn that had them, so the
            # model can keep referring back to the picture across multi-
            # turn conversations. Vision-incapable models silently drop
            # the bytes (the textual marker + warning above covers it).
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

            if image_parts:
                # Multimodal turn: TextPart first so the question reads
                # naturally above the image(s) in the model's context.
                content_parts: list[ContentPart] = []
                if full_text:
                    content_parts.append(TextPart(text=full_text))
                content_parts.extend(image_parts)
                history.append(ChatMessage(role=m.role, content=content_parts))
            else:
                # Plain text turn — keep the legacy str path so wire
                # format stays byte-identical to pre-Phase 4 behaviour.
                if not full_text:
                    continue
                history.append(ChatMessage(role=m.role, content=full_text))
        # Capture whether this stream will produce the conversation's first
        # assistant turn — that's when we generate the AI title.
        is_first_turn = not any(m.role == "assistant" for m in history_rows)
        first_user_message = next(
            (m.content for m in history_rows if m.role == "user"), ""
        )

        yield _sse({"event": "start", "stream_id": str(stream_id)})

        # Forward any vision-related warnings (non-vision model + image
        # attachment, oversized image, etc.) so the UI can surface them
        # before any tokens stream in.
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

        enabled_categories: set[str] = set()
        if ctx.get("tools_enabled"):
            enabled_categories.add("artefact")
        if web_search_mode != "off":
            enabled_categories.add("search")

        tools_payload: list[dict[str, Any]] | None = (
            list_openai_tools(enabled_categories) if enabled_categories else None
        )

        # Phase P1 — project-level instructions are the baseline
        # system prompt. Tool-aware + personal-context prompts are
        # merged on top below, each taking precedence (since
        # ``merge_system_prompt`` puts the first argument first).
        system_prompt: str | None = project_system_prompt
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

        collected_text: list[str] = []
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

        try:
            for hop in range(MAX_TOOL_HOPS):
                # Accumulators for the *current* hop. Tool-call deltas
                # come back fragmented per ``index``; we merge by index.
                hop_text_parts: list[str] = []
                # Each entry: {"id": str, "name": str, "arguments": str}
                pending_calls: dict[int, dict[str, str]] = {}
                hop_finish: str | None = None

                async for ev in model_router.stream_chat_events(
                    provider=provider,
                    model_id=ctx["model_id"],
                    messages=running_history,
                    system=system_prompt,
                    temperature=ctx["temperature"],
                    max_tokens=ctx["max_tokens"],
                    tools=tools_payload,
                    include_usage=True,
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

                # Plain reply — no tool calls. We're done.
                if hop_finish != "tool_calls" or not pending_calls:
                    # Diagnostic: tools were on but the model never
                    # actually called any. Useful for spotting models
                    # (Gemini-via-OpenRouter is the usual culprit) that
                    # silently drop ``tools[]`` without erroring. Logged
                    # at INFO so it shows up in normal operations
                    # tailing without polluting the audit log; no SSE
                    # event because the user already got a normal reply.
                    if hop == 0 and tools_payload:
                        logger.info(
                            "Tools enabled but model declined to call any "
                            "(stream=%s model=%s tools=%d)",
                            stream_id,
                            ctx["model_id"],
                            len(tools_payload),
                        )
                    break

                # ---- Dispatch the tools the model asked for ----
                # Append the assistant turn carrying the tool_calls so
                # the follow-up call has the right conversational shape.
                tool_calls_payload = _build_tool_calls_payload(pending_calls)
                running_history.append(
                    {
                        "role": "assistant",
                        # OpenAI's protocol allows null content here
                        # when the assistant produced only tool calls.
                        "content": hop_text or None,
                        "tool_calls": tool_calls_payload,
                    }
                )

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
                ):
                    # Always forward the SSE event. ``tool_history_msg``
                    # is None for "started" pre-events (which have no
                    # OpenAI counterpart); only "finished" events carry
                    # a history row to feed back to the next hop.
                    yield sse_event
                    if tool_history_msg is not None:
                        running_history.append(tool_history_msg)
            else:
                # MAX_TOOL_HOPS exhausted without the model producing a
                # final text turn — treat as a soft error so the user
                # isn't left looking at an empty bubble.
                yield _sse(
                    {
                        "event": "tool_error",
                        "error": (
                            f"Model exceeded the {MAX_TOOL_HOPS}-hop tool "
                            "limit without finishing. Stopping."
                        ),
                    }
                )
        except ProviderError as e:
            logger.warning("Provider error on stream %s: %s", stream_id, e)
            # Classify the error so the frontend can render an
            # actionable card (link to the upstream settings page,
            # "Pick another model" button, etc.) instead of the raw
            # upstream dump. Fallthrough is unclassified — renders as
            # a plain red banner exactly like before.
            classified = _classify_upstream_error(str(e), provider_type=provider.type)
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
        full = "".join(collected_text)
        sources_payload: list[dict[str, Any]] | None = (
            _dedupe_sources(sources_accumulator) if sources_accumulator else None
        )
        # Convert dollars to integer micros for the message column. We
        # keep ``cost_usd`` as a float locally (sums and SSE) and only
        # round at the persistence boundary.
        cost_micros: int | None = None
        if cost_usd is not None:
            cost_micros = max(0, int(round(cost_usd * 1_000_000)))

        assistant = Message(
            conversation_id=conv.id,
            role="assistant",
            content=full,
            sources=sources_payload,
            attachments=assistant_attachment_snaps or None,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            ttft_ms=ttft_ms,
            total_ms=total_ms,
            cost_usd_micros=cost_micros,
        )
        db.add(assistant)
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

        # Auto-title the conversation after the first successful exchange.
        # Anything the user has already renamed is left untouched.
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
                # Per-message dollar cost (provider completion + any
                # paid tools that ran on this turn). Floats are fine
                # over the wire — micros stays a server-side detail.
                "cost_usd": cost_usd,
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
    project_id: uuid.UUID | None = Form(default=None),
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

    Optional ``project_id`` form field drops every imported
    conversation into the named project — a shortcut for "migrate
    everything from ChatGPT into this one project". Rejected if the
    project belongs to someone else or doesn't exist.
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

    # Optional project target.
    project_row: ChatProject | None = None
    if project_id is not None:
        project_row = await db.get(ChatProject, project_id)
        if project_row is None or project_row.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown project",
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
            project_id=project_row.id if project_row else None,
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
        for msg in parsed.messages[:_IMPORT_MAX_MESSAGES_PER_CONV]:
            m = Message(
                conversation_id=conv.id,
                role=msg.role,
                content=msg.content,
                sources=msg.sources,
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
            count += 1
        total_messages += count

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
                    "project_id": str(project_row.id) if project_row else None,
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


# ====================================================================
# Sharing sub-router (Phase 4b) — mounted at the same /api/chat prefix
# ====================================================================
from app.chat.shares import router as _shares_router  # noqa: E402,I001

router.include_router(_shares_router)

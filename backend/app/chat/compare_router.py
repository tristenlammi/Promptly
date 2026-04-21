"""Side-by-side compare-mode API.

Each compare group bundles N (2–4) real ``conversations`` rows —
one per column — linked through ``conversations.compare_group_id``.
The regular send/stream pipeline does the heavy lifting per column;
this router is responsible for:

* Creating the group + its per-column conversations in a single call
  (``POST /compare/groups``).
* Fanning a prompt out to all columns in one request so the frontend
  opens N SSE streams in parallel without N round-trips
  (``POST /compare/groups/{id}/send``).
* Crowning a winner — the chosen conversation surfaces in the normal
  sidebar, losers remain accessible via the archive list
  (``POST /compare/groups/{id}/crown``).
* Listing + archiving groups (``GET /compare/groups``,
  ``POST /compare/groups/{id}/archive``).

Compare mode intentionally disables tools, web search, and the
PDF editor per column — different models have different tool
support, and forcing a lowest-common-denominator set prevents
one column surprising the user with an artifact another column
can't match. The frontend enforces the UX; the backend enforces
the data contract by forcing ``tools_enabled=False`` and
``web_search_mode="off"`` on every stream it enqueues here.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.compare_schemas import (
    CompareColumnSummary,
    CompareCrownRequest,
    CompareGroupArchiveFilter,
    CompareGroupCreate,
    CompareGroupDetail,
    CompareGroupSummary,
    CompareSendColumn,
    CompareSendRequest,
    CompareSendResponse,
)
from app.chat.models import CompareGroup, Conversation, Message
from app.chat.service import StreamContext, enqueue_stream
from app.chat.titler import fallback_title
from app.database import get_db
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.chat.compare")

router = APIRouter(prefix="/api/chat/compare", tags=["compare"])


async def _resolve_provider_for_user(
    provider_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> ModelProvider:
    """Mirror the provider-auth check used by ``send_message`` so
    compare columns play by the same rules: any provider owned by
    an admin or the caller themselves is fair game; other users'
    private providers are off-limits."""
    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown provider",
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown provider",
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider {provider.name} is disabled.",
        )
    return provider


async def _load_group_for_user(
    group_id: uuid.UUID, user: User, db: AsyncSession
) -> CompareGroup:
    group = await db.get(CompareGroup, group_id)
    if group is None or group.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Compare group not found",
        )
    return group


async def _build_detail(
    group: CompareGroup, db: AsyncSession
) -> CompareGroupDetail:
    """Load a group's columns + enrich with model/provider display
    names for the UI. Separate helper because both ``create`` and
    ``get`` need to return the same shape."""
    convs = (
        (
            await db.execute(
                select(Conversation)
                .where(Conversation.compare_group_id == group.id)
                .order_by(Conversation.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    # Prefetch provider rows once rather than per-column.
    provider_ids = {c.provider_id for c in convs if c.provider_id}
    providers: dict[uuid.UUID, ModelProvider] = {}
    if provider_ids:
        rows = (
            (
                await db.execute(
                    select(ModelProvider).where(
                        ModelProvider.id.in_(provider_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        providers = {p.id: p for p in rows}

    columns: list[CompareColumnSummary] = []
    for c in convs:
        provider = providers.get(c.provider_id) if c.provider_id else None
        display_name = None
        if provider and provider.models:
            for m in provider.models:
                if isinstance(m, dict) and m.get("id") == c.model_id:
                    display_name = m.get("display_name") or c.model_id
                    break
        columns.append(
            CompareColumnSummary(
                conversation_id=c.id,
                provider_id=c.provider_id,
                model_id=c.model_id,
                model_display_name=display_name or c.model_id,
                provider_name=provider.name if provider else None,
                is_crowned=(
                    group.crowned_conversation_id is not None
                    and group.crowned_conversation_id == c.id
                ),
            )
        )

    return CompareGroupDetail(
        id=group.id,
        title=group.title,
        seed_prompt=group.seed_prompt,
        crowned_conversation_id=group.crowned_conversation_id,
        archived_at=group.archived_at,
        created_at=group.created_at,
        updated_at=group.updated_at,
        column_count=len(columns),
        columns=columns,
    )


@router.post(
    "/groups",
    response_model=CompareGroupDetail,
    status_code=status.HTTP_201_CREATED,
)
async def create_compare_group(
    payload: CompareGroupCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompareGroupDetail:
    """Create a compare group with N columns.

    Creates N conversations up-front (one per column) so each column
    immediately has a stable ``conversation_id`` the frontend can
    attach SSE to. If ``seed_prompt`` is provided, a send is also
    fanned out across every column before returning; the frontend
    picks up the streams via the detail response + a follow-up call
    to the usual stream endpoint.
    """
    # Validate every provider before creating anything so a bad
    # column doesn't leave us with a half-built group.
    resolved: list[tuple[ModelProvider, str]] = []
    for col in payload.columns:
        provider = await _resolve_provider_for_user(col.provider_id, user, db)
        if user.role != "admin" and user.allowed_models is not None:
            if col.model_id not in set(user.allowed_models):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=(
                        f"You don't have access to model {col.model_id}. "
                        "Ask an admin to grant it."
                    ),
                )
        resolved.append((provider, col.model_id))

    group = CompareGroup(
        user_id=user.id,
        title=payload.title,
        seed_prompt=payload.seed_prompt,
    )
    db.add(group)
    await db.flush()  # populate group.id

    # Create the per-column conversations. Each gets a title derived
    # from the seed prompt so the sidebar (once crowned) has a
    # meaningful label straight away.
    title = (
        fallback_title(payload.seed_prompt)
        if payload.seed_prompt
        else (payload.title or "Compare")
    )
    columns: list[Conversation] = []
    for provider, model_id in resolved:
        conv = Conversation(
            user_id=user.id,
            title=title,
            provider_id=provider.id,
            model_id=model_id,
            web_search_mode="off",
            compare_group_id=group.id,
        )
        db.add(conv)
        columns.append(conv)

    await db.flush()

    # Optionally seed with a first turn. We deliberately commit the
    # group + columns before enqueuing streams so a queue worker
    # picking up the stream can find the row.
    await db.commit()

    if payload.seed_prompt:
        await _send_across_columns(
            group=group,
            columns=columns,
            content=payload.seed_prompt,
            user=user,
            db=db,
        )

    return await _build_detail(group, db)


async def _send_across_columns(
    *,
    group: CompareGroup,
    columns: list[Conversation],
    content: str,
    user: User,
    db: AsyncSession,
) -> list[CompareSendColumn]:
    """Persist the user message in each column and enqueue its
    stream. Returns one descriptor per column so the frontend can
    subscribe immediately.

    Compare mode forces ``tools_enabled=False`` and
    ``web_search_mode="off"`` on every column — see module docstring
    for rationale.
    """
    now = datetime.now(timezone.utc)
    out: list[CompareSendColumn] = []
    for conv in columns:
        user_msg = Message(
            conversation_id=conv.id,
            role="user",
            content=content,
            author_user_id=user.id,
        )
        db.add(user_msg)
        conv.updated_at = now
        await db.flush()

        stream_id = uuid.uuid4()
        ctx: StreamContext = {
            "conversation_id": str(conv.id),
            "user_message_id": str(user_msg.id),
            "provider_id": str(conv.provider_id),
            "model_id": conv.model_id or "",
            "web_search_mode": "off",
            # Compare columns use the chat default (0.7) so each
            # model's answer is comparable on an equal footing; if a
            # user wants custom temperature they can crown a winner
            # and continue the chat from the normal composer.
            "temperature": 0.7,
            "max_tokens": None,
            "tools_enabled": False,
        }
        await enqueue_stream(stream_id, ctx)
        out.append(
            CompareSendColumn(
                conversation_id=conv.id,
                stream_id=stream_id,
                user_message_id=user_msg.id,
            )
        )

    group.updated_at = now
    await db.commit()
    return out


@router.get(
    "/groups",
    response_model=list[CompareGroupSummary],
)
async def list_compare_groups(
    filter: CompareGroupArchiveFilter = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CompareGroupSummary]:
    """List the user's compare groups for the archive view.

    ``filter``:
      * ``"active"``   — not archived (default surface for the user
                         to resume an in-flight comparison).
      * ``"archived"`` — only archived groups.
      * ``"all"``      — everything the user has ever created.
    """
    stmt = select(CompareGroup).where(CompareGroup.user_id == user.id)
    if filter == "active":
        stmt = stmt.where(CompareGroup.archived_at.is_(None))
    elif filter == "archived":
        stmt = stmt.where(CompareGroup.archived_at.is_not(None))
    stmt = stmt.order_by(CompareGroup.updated_at.desc()).limit(limit).offset(offset)
    rows = (await db.execute(stmt)).scalars().all()

    # Column counts in one round-trip rather than one-per-group.
    counts: dict[uuid.UUID, int] = {}
    if rows:
        count_rows = (
            await db.execute(
                select(Conversation.compare_group_id, func.count(Conversation.id))
                .where(
                    Conversation.compare_group_id.in_([r.id for r in rows])
                )
                .group_by(Conversation.compare_group_id)
            )
        ).all()
        counts = {gid: int(cnt) for gid, cnt in count_rows}

    return [
        CompareGroupSummary(
            id=g.id,
            title=g.title,
            seed_prompt=g.seed_prompt,
            crowned_conversation_id=g.crowned_conversation_id,
            archived_at=g.archived_at,
            created_at=g.created_at,
            updated_at=g.updated_at,
            column_count=counts.get(g.id, 0),
        )
        for g in rows
    ]


@router.get(
    "/groups/{group_id}",
    response_model=CompareGroupDetail,
)
async def get_compare_group(
    group_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompareGroupDetail:
    group = await _load_group_for_user(group_id, user, db)
    return await _build_detail(group, db)


@router.post(
    "/groups/{group_id}/send",
    response_model=CompareSendResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def send_to_compare_group(
    group_id: uuid.UUID,
    payload: CompareSendRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompareSendResponse:
    """Fan a prompt out to every column of a compare group.

    Rejected if the group has already been crowned — at that point
    the group is a historical record; continuing the conversation
    happens on the crowned chat via the normal send-message flow.
    """
    group = await _load_group_for_user(group_id, user, db)
    if group.crowned_conversation_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This comparison has been crowned. Continue the "
                "conversation on the winning chat instead."
            ),
        )

    columns = (
        (
            await db.execute(
                select(Conversation)
                .where(Conversation.compare_group_id == group.id)
                .order_by(Conversation.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    if not columns:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Compare group has no columns left to send to.",
        )

    descriptors = await _send_across_columns(
        group=group,
        columns=list(columns),
        content=payload.content,
        user=user,
        db=db,
    )
    return CompareSendResponse(columns=descriptors)


@router.post(
    "/groups/{group_id}/crown",
    response_model=CompareGroupDetail,
)
async def crown_compare_column(
    group_id: uuid.UUID,
    payload: CompareCrownRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompareGroupDetail:
    """Pick a winning column.

    The referenced conversation surfaces as a normal sidebar chat
    (the ``list_conversations`` filter lets crowned columns through);
    the losing columns stay attached to the group and can still be
    opened via the Compare archive view.

    Crowning is reversible via a follow-up call with a different
    ``conversation_id`` — the previous crown is overwritten. That's
    intentional: "actually, let me re-read the other answer" is a
    common need and we don't want to lock the user in.
    """
    group = await _load_group_for_user(group_id, user, db)

    target = await db.get(Conversation, payload.conversation_id)
    if (
        target is None
        or target.user_id != user.id
        or target.compare_group_id != group.id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That column doesn't belong to this compare group.",
        )

    group.crowned_conversation_id = target.id
    group.updated_at = datetime.now(timezone.utc)
    # Refresh the target conversation's updated_at so it jumps to
    # the top of the user's normal sidebar the moment it's crowned.
    target.updated_at = group.updated_at
    await db.commit()
    await db.refresh(group)

    return await _build_detail(group, db)


@router.post(
    "/groups/{group_id}/archive",
    response_model=CompareGroupSummary,
)
async def archive_compare_group(
    group_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompareGroupSummary:
    """Soft-archive a compare group.

    Archiving hides it from the default "active" list but keeps every
    row intact so the user can still reopen a losing column if they
    change their mind. Unarchive by calling again on an already-
    archived group (symmetric toggle).
    """
    group = await _load_group_for_user(group_id, user, db)
    group.archived_at = (
        None if group.archived_at is not None else datetime.now(timezone.utc)
    )
    group.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(group)

    column_count = int(
        (
            await db.execute(
                select(func.count(Conversation.id)).where(
                    Conversation.compare_group_id == group.id
                )
            )
        ).scalar_one()
    )

    return CompareGroupSummary(
        id=group.id,
        title=group.title,
        seed_prompt=group.seed_prompt,
        crowned_conversation_id=group.crowned_conversation_id,
        archived_at=group.archived_at,
        created_at=group.created_at,
        updated_at=group.updated_at,
        column_count=column_count,
    )


@router.delete(
    "/groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_compare_group(
    group_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Hard-delete a compare group and every non-crowned column.

    The crowned conversation (if any) is *detached* from the group
    via the FK ``ON DELETE SET NULL`` and kept as a regular chat —
    the user explicitly chose to keep it. Every other column is
    removed along with the group so orphaned rows don't pile up.
    """
    group = await _load_group_for_user(group_id, user, db)

    columns = (
        (
            await db.execute(
                select(Conversation).where(
                    Conversation.compare_group_id == group.id
                )
            )
        )
        .scalars()
        .all()
    )
    for conv in columns:
        if (
            group.crowned_conversation_id is not None
            and conv.id == group.crowned_conversation_id
        ):
            # Preserve the crowned chat; FK goes to NULL when the
            # group is deleted.
            continue
        await db.delete(conv)

    await db.delete(group)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

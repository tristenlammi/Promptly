"""Conversation access checks + shared share primitives.

Per-conversation sharing (inviting another user to a single chat) was
removed — it was little-used and left recipients unable to drop a
shared chat from their list. **Project**-level sharing remains the
single collaboration surface, so this module keeps the access helpers
that both surfaces rely on:

* :func:`is_owner_of_conversation` — single membership test for
  endpoints that should never be exposed to a collaborator
  (delete, settings).
* :func:`get_accessible_conversation` — owner *or* a collaborator who
  reached the chat through an accepted *project* share.

It also still owns the small share DTO/helper primitives
(:class:`ShareUserBrief`, :func:`_brief`, :func:`_resolve_invitee`,
:class:`CreateShareRequest`) that :mod:`app.chat.project_shares`
imports so the "find user by handle" path stays a single code path.
"""
from __future__ import annotations

import logging
import uuid
from typing import Literal

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Conversation, ProjectShare

logger = logging.getLogger("promptly.chat.shares")


# ====================================================================
# Internal access helpers
# ====================================================================
async def is_owner_of_conversation(
    conversation_id: uuid.UUID, user: User, db: AsyncSession
) -> Conversation:
    """Return the conversation iff ``user`` owns it, else 404.

    404 (not 403) so the existence of someone else's chat isn't
    leaked through error codes. Mirrors ``_get_owned_conversation``
    in the chat router; kept here to break the import cycle so this
    module can also be imported from ``app/chat/router.py`` itself.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found",
        )
    return conv


async def _has_project_access(
    project_id: uuid.UUID | None, user: User, db: AsyncSession
) -> bool:
    """Does ``user`` have any path to the given project?

    Used by :func:`get_accessible_conversation` as a second check
    after the ownership test: if the chat lives in a project the
    caller either owns or has an accepted project share for, they
    inherit read/post access.

    Returning early for ``project_id is None`` keeps call sites
    free of a None-guard — almost every conversation is project-less
    so this path short-circuits cheaply.
    """
    if project_id is None:
        return False
    # Import lazily to avoid a circular import at module load — the
    # projects router imports from ``shares.py`` for its own access
    # helpers, and :class:`ChatProject` pulls in the whole project
    # tree.
    from app.chat.models import ChatProject

    proj = await db.get(ChatProject, project_id)
    if proj is None:
        return False
    if proj.user_id == user.id:
        return True
    share = (
        await db.execute(
            select(ProjectShare).where(
                ProjectShare.project_id == project_id,
                ProjectShare.invitee_user_id == user.id,
                ProjectShare.status == "accepted",
            )
        )
    ).scalars().first()
    return share is not None


async def get_accessible_conversation(
    conversation_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[Conversation, Literal["owner", "collaborator"]]:
    """Resolve a conversation the caller can read or post into.

    Returns ``(conversation, role)`` where ``role`` is ``"owner"``
    when the caller created the chat or ``"collaborator"`` when they
    reached it through an accepted *project* share. Anything else
    404s — same response shape an unrelated random UUID would produce.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found",
        )
    # Phase Z1 — temporary chats lazy-expire. A conversation past its
    # ``expires_at`` is treated as if the sweeper has already deleted
    # it: 404 same as a stranger's chat. The actual row is reaped by
    # the background sweeper a few minutes later.
    if conv.expires_at is not None:
        from datetime import datetime, timezone as _tz

        if conv.expires_at <= datetime.now(_tz.utc):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Conversation not found",
            )
    if conv.user_id == user.id:
        return conv, "owner"

    # 0031 — project-level sharing. If the chat lives in a project
    # the caller has accepted a share on (or owns outright), they
    # inherit collaborator access to every conversation under that
    # project. The ``owner`` role is reserved for the literal
    # conversation creator so the send path can still reject edits
    # on someone else's messages.
    if await _has_project_access(conv.project_id, user, db):
        return conv, "collaborator"

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Conversation not found",
    )


async def list_accessible_conversation_ids(
    user: User, db: AsyncSession
) -> list[uuid.UUID]:
    """All conversation ids the caller can read — owned + project share.

    Used by the cross-chat full-text search to widen the ``WHERE``
    clause without a JOIN at each call site. The project-share path
    brings in every chat under any project the caller has accepted a
    share on.
    """
    # Project ids the caller has *any* access to (owned + accepted
    # share). Gather once and pass as an ``IN`` clause rather than
    # joining through more tables in the main query.
    accessible_project_ids = await list_accessible_project_ids(user, db)

    conds = [Conversation.user_id == user.id]
    if accessible_project_ids:
        conds.append(Conversation.project_id.in_(accessible_project_ids))

    res = await db.execute(select(Conversation.id).where(or_(*conds)))
    return list({row[0] for row in res.all()})


async def list_accessible_project_ids(
    user: User, db: AsyncSession
) -> list[uuid.UUID]:
    """Project ids the caller owns or has an accepted share on.

    Deliberately tiny — the project share scale is "a handful per
    user" so we don't bother with a composite index query. Called
    by :func:`list_accessible_conversation_ids` and by the project
    list endpoint to surface shared projects in the same UI as
    owned ones.
    """
    # Import lazily — see note in ``_has_project_access``.
    from app.chat.models import ChatProject

    owned_res = await db.execute(
        select(ChatProject.id).where(ChatProject.user_id == user.id)
    )
    shared_res = await db.execute(
        select(ProjectShare.project_id).where(
            ProjectShare.invitee_user_id == user.id,
            ProjectShare.status == "accepted",
        )
    )
    ids: set[uuid.UUID] = set()
    for row in owned_res.all():
        ids.add(row[0])
    for row in shared_res.all():
        ids.add(row[0])
    return list(ids)


# ====================================================================
# DTOs
# ====================================================================
class ShareUserBrief(BaseModel):
    """Minimal user identity used in participant lists + author chips."""

    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    username: str
    email: str


class ConversationParticipants(BaseModel):
    """Owner + collaborators surfaced in the conversation detail view.

    Collaborators are the people who reached the chat through an
    accepted share on its *project* (per-chat sharing was removed).
    Used to render "from Jane" chips on user messages in project-
    shared chats.
    """

    owner: ShareUserBrief
    collaborators: list[ShareUserBrief] = Field(default_factory=list)


class CreateShareRequest(BaseModel):
    """Resolve a share target by ``username`` or ``email``.

    Exactly one identifier is required; the API resolves it to a
    user id internally. Still used by project sharing via
    :func:`_resolve_invitee`.
    """

    username: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=320)


# ====================================================================
# Helpers
# ====================================================================
async def _resolve_invitee(
    payload: CreateShareRequest, db: AsyncSession
) -> User:
    if not payload.username and not payload.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide a username or email to invite.",
        )
    stmt = select(User)
    if payload.username:
        stmt = stmt.where(User.username == payload.username.strip())
    else:
        stmt = stmt.where(User.email == (payload.email or "").strip().lower())
    user = (await db.execute(stmt)).scalars().first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No user found with that handle.",
        )
    return user


def _brief(u: User) -> ShareUserBrief:
    return ShareUserBrief(user_id=u.id, username=u.username, email=u.email)


async def load_participants(
    conv: Conversation, db: AsyncSession
) -> ConversationParticipants:
    """Resolve the owner and collaborators for a conversation.

    Collaborators come from accepted shares on the chat's *project*
    (per-chat sharing was removed). A project-less chat therefore has
    no collaborators. Cheap enough to run on every conversation-detail
    request without caching.
    """
    owner = await db.get(User, conv.user_id)
    if owner is None:
        # Genuinely impossible under the current schema (owner ON
        # DELETE CASCADE drops the conversation), but defending here
        # keeps the rest of the code able to assume "owner is real".
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Conversation owner missing",
        )

    collaborators: list[ShareUserBrief] = []
    if conv.project_id is not None:
        rows = (
            await db.execute(
                select(User)
                .join(ProjectShare, ProjectShare.invitee_user_id == User.id)
                .where(
                    ProjectShare.project_id == conv.project_id,
                    ProjectShare.status == "accepted",
                )
                .order_by(User.username.asc())
            )
        ).scalars().all()
        collaborators = [_brief(u) for u in rows]

    return ConversationParticipants(
        owner=_brief(owner),
        collaborators=collaborators,
    )

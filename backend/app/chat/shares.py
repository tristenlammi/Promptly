"""Conversation sharing — invites, acceptance, access checks.

Sits alongside the chat router and exposes a sub-router (mounted at
``/api/chat``) plus an ``access_check`` helper used by the chat
endpoints to widen ownership tests beyond the original ``user_id``
column. Two ACL primitives:

* :func:`is_owner_of_conversation` — single membership test for
  endpoints that should never be exposed to a collaborator
  (delete, share-management).
* :func:`get_accessible_conversation` — owner *or* collaborator with
  an ``accepted`` share row. Used by every read/post endpoint.

Cost rolls onto the user who posts the turn (the chat router still
calls :func:`record_usage` with the authenticated sender), so the
sharing system has no special billing surface — by design.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, ConversationShare
from app.database import get_db

logger = logging.getLogger("promptly.chat.shares")
router = APIRouter()

# Statuses the database may hold. Public API only ever exposes the
# first three values; ``revoked`` isn't a stored state (revoke = row
# delete) but listed here so type-checkers stay honest.
ShareStatus = Literal["pending", "accepted", "declined"]


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


async def _accepted_share(
    conversation_id: uuid.UUID, user: User, db: AsyncSession
) -> ConversationShare | None:
    res = await db.execute(
        select(ConversationShare).where(
            ConversationShare.conversation_id == conversation_id,
            ConversationShare.invitee_user_id == user.id,
            ConversationShare.status == "accepted",
        )
    )
    return res.scalars().first()


async def get_accessible_conversation(
    conversation_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> tuple[Conversation, Literal["owner", "collaborator"]]:
    """Resolve a conversation the caller can read or post into.

    Returns ``(conversation, role)`` where ``role`` is ``"owner"``
    when the caller created the chat or ``"collaborator"`` when they
    have an ``accepted`` share row. Anything else 404s — same
    response shape an unrelated random UUID would produce.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found",
        )
    if conv.user_id == user.id:
        return conv, "owner"

    share = await _accepted_share(conv.id, user, db)
    if share is not None:
        return conv, "collaborator"

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Conversation not found",
    )


async def list_accessible_conversation_ids(
    user: User, db: AsyncSession
) -> list[uuid.UUID]:
    """All conversation ids the caller can read — owned + accepted.

    Used by the conversation list endpoint and by the cross-chat
    full-text search to widen the ``WHERE`` clause without a JOIN at
    each call site.
    """
    res = await db.execute(
        select(Conversation.id)
        .outerjoin(
            ConversationShare,
            (ConversationShare.conversation_id == Conversation.id)
            & (ConversationShare.invitee_user_id == user.id)
            & (ConversationShare.status == "accepted"),
        )
        .where(
            or_(
                Conversation.user_id == user.id,
                ConversationShare.id.is_not(None),
            )
        )
    )
    return [row[0] for row in res.all()]


# ====================================================================
# DTOs
# ====================================================================
class ShareUserBrief(BaseModel):
    """Minimal user identity used in share lists + author chips."""

    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    username: str
    email: str


class ShareRow(BaseModel):
    """One row in the owner's "people on this chat" list."""

    id: uuid.UUID
    conversation_id: uuid.UUID
    invitee: ShareUserBrief
    status: ShareStatus
    created_at: datetime
    accepted_at: datetime | None


class InviteRow(BaseModel):
    """A pending invitation as seen by the *invitee*."""

    id: uuid.UUID
    conversation_id: uuid.UUID
    conversation_title: str | None
    inviter: ShareUserBrief
    created_at: datetime


class ConversationParticipants(BaseModel):
    """Owner + collaborators surfaced in the conversation detail view.

    The frontend uses this to render "from Jane" chips on user
    messages in shared chats and to hide the share button from
    non-owners. The collaborators list excludes any pending or
    declined invites — only people who actually accepted.
    """

    owner: ShareUserBrief
    collaborators: list[ShareUserBrief] = Field(default_factory=list)


class CreateShareRequest(BaseModel):
    """Owner asks to share with ``username`` or ``email``.

    Exactly one identifier is required; the API resolves it to a
    user id internally. Returning the resolved user back in the
    response keeps the frontend from having to round-trip again to
    render the "invited Jane" toast.
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
    """Resolve the owner and accepted collaborators for a conversation.

    One round-trip each (owner load + accepted-share join). Cheap
    enough that we run it on every conversation-detail request rather
    than caching; the conversation page is opened once per
    interaction.
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

    rows = (
        await db.execute(
            select(User)
            .join(
                ConversationShare,
                ConversationShare.invitee_user_id == User.id,
            )
            .where(
                ConversationShare.conversation_id == conv.id,
                ConversationShare.status == "accepted",
            )
            .order_by(User.username.asc())
        )
    ).scalars().all()

    return ConversationParticipants(
        owner=_brief(owner),
        collaborators=[_brief(u) for u in rows],
    )


# ====================================================================
# Endpoints — owner perspective
# ====================================================================
@router.get(
    "/conversations/{conversation_id}/shares",
    response_model=list[ShareRow],
)
async def list_conversation_shares(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ShareRow]:
    """List every share row for a conversation. Owner only.

    Returns pending + accepted + declined rows so the owner can see
    "I invited Jane, she hasn't responded yet" alongside accepted
    collaborators. Ordered by created_at desc so the latest invite
    sits at the top.
    """
    conv = await is_owner_of_conversation(conversation_id, user, db)
    rows = (
        await db.execute(
            select(ConversationShare, User)
            .join(User, User.id == ConversationShare.invitee_user_id)
            .where(ConversationShare.conversation_id == conv.id)
            .order_by(ConversationShare.created_at.desc())
        )
    ).all()
    return [
        ShareRow(
            id=share.id,
            conversation_id=share.conversation_id,
            invitee=_brief(invitee),
            status=share.status,  # type: ignore[arg-type]
            created_at=share.created_at,
            accepted_at=share.accepted_at,
        )
        for share, invitee in rows
    ]


@router.post(
    "/conversations/{conversation_id}/shares",
    response_model=ShareRow,
    status_code=status.HTTP_201_CREATED,
)
async def create_conversation_share(
    conversation_id: uuid.UUID,
    payload: CreateShareRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ShareRow:
    """Invite someone to collaborate on a conversation. Owner only.

    Idempotent on (conversation, invitee): re-inviting a user with a
    pending row returns the existing row, re-inviting after they
    declined resets it to ``pending`` so they can reconsider, and
    inviting yourself or the existing owner is a no-op 400.
    """
    conv = await is_owner_of_conversation(conversation_id, user, db)
    invitee = await _resolve_invitee(payload, db)

    if invitee.id == user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You're already on this conversation.",
        )

    existing = (
        await db.execute(
            select(ConversationShare).where(
                ConversationShare.conversation_id == conv.id,
                ConversationShare.invitee_user_id == invitee.id,
            )
        )
    ).scalars().first()

    now = datetime.now(timezone.utc)
    if existing is not None:
        if existing.status == "declined":
            existing.status = "pending"
            existing.updated_at = now
            await db.commit()
            await db.refresh(existing)
        share = existing
    else:
        share = ConversationShare(
            conversation_id=conv.id,
            inviter_user_id=user.id,
            invitee_user_id=invitee.id,
            status="pending",
        )
        db.add(share)
        await db.commit()
        await db.refresh(share)

    return ShareRow(
        id=share.id,
        conversation_id=share.conversation_id,
        invitee=_brief(invitee),
        status=share.status,  # type: ignore[arg-type]
        created_at=share.created_at,
        accepted_at=share.accepted_at,
    )


@router.delete(
    "/conversations/{conversation_id}/shares/{share_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def revoke_conversation_share(
    conversation_id: uuid.UUID,
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner revokes a share OR invitee declines/leaves a chat.

    Both flows hard-delete the row. The unique constraint on
    ``(conversation_id, invitee_user_id)`` means a re-invite always
    starts a fresh row with ``status='pending'``, which is exactly
    what users expect.
    """
    share = await db.get(ConversationShare, share_id)
    if share is None or share.conversation_id != conversation_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share not found"
        )
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )

    is_owner = conv.user_id == user.id
    is_invitee = share.invitee_user_id == user.id
    if not (is_owner or is_invitee):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Share not found"
        )

    await db.delete(share)
    await db.commit()


# ====================================================================
# Endpoints — invitee perspective
# ====================================================================
@router.get("/share-invites", response_model=list[InviteRow])
async def list_share_invites(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[InviteRow]:
    """All pending invites the caller has yet to accept or decline."""
    rows = (
        await db.execute(
            select(ConversationShare, Conversation, User)
            .join(Conversation, Conversation.id == ConversationShare.conversation_id)
            .join(User, User.id == ConversationShare.inviter_user_id)
            .where(
                ConversationShare.invitee_user_id == user.id,
                ConversationShare.status == "pending",
            )
            .order_by(ConversationShare.created_at.desc())
        )
    ).all()
    return [
        InviteRow(
            id=share.id,
            conversation_id=conv.id,
            conversation_title=conv.title,
            inviter=_brief(inviter),
            created_at=share.created_at,
        )
        for share, conv, inviter in rows
    ]


@router.post(
    "/share-invites/{share_id}/accept",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def accept_share_invite(
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    share = await db.get(ConversationShare, share_id)
    if share is None or share.invitee_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found"
        )
    if share.status == "accepted":
        return  # idempotent
    if share.status == "declined":
        # Re-accepting a previously-declined invite is fine — the
        # row is still there because the inviter never re-invited.
        pass

    share.status = "accepted"
    share.accepted_at = datetime.now(timezone.utc)
    share.updated_at = datetime.now(timezone.utc)
    await db.commit()


@router.post(
    "/share-invites/{share_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def decline_share_invite(
    share_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    share = await db.get(ConversationShare, share_id)
    if share is None or share.invitee_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found"
        )
    if share.status == "declined":
        return  # idempotent
    share.status = "declined"
    share.accepted_at = None
    share.updated_at = datetime.now(timezone.utc)
    await db.commit()

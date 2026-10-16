"""Delete a user without taking other people's work with them (R-004).

DB-level ``ON DELETE CASCADE`` removes everything a user owns. That used to
include every workspace they owned — and with it notes, boards and files
their collaborators wrote, which are stored under the owner's account — plus
the shares they'd sent (so members of *other* workspaces lost access) and
the workspace chats they'd started. All of it went with no record.

Now deletion is an offboarding step:

* workspaces that have other members must be handed to a new owner first
  (:func:`app.workspaces.ownership.transfer_workspace`); the admin picks who;
* invitations the user sent and workspace-visible chats they started in
  workspaces that survive are handed to that workspace's owner;
* the user's own bytes are tombstoned, not unlinked — recoverable for 14 days;
* an ``user_deleted`` audit event records who did it and what went.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Conversation, Workspace, WorkspaceShare
from app.files.models import UserFile
from app.files.tombstones import tombstone
from app.workspaces.ownership import member_ids, transfer_workspace

logger = logging.getLogger("promptly.deletion")

EVENT_USER_DELETED = "user_deleted"


class DeletionRefused(Exception):
    """The deletion can't go ahead as asked; ``str(e)`` is user-safe."""


def _protected(user: User) -> bool:
    """Never purge an admin — a backstop so the instance owner can't be erased."""
    return user.role == "admin"


@dataclass
class OwnedWorkspace:
    id: uuid.UUID
    title: str
    member_ids: list[uuid.UUID]


@dataclass
class DeletionPreview:
    file_count: int = 0
    file_bytes: int = 0
    conversation_count: int = 0
    workspaces: list[OwnedWorkspace] = field(default_factory=list)


async def deletion_preview(db: AsyncSession, user: User) -> DeletionPreview:
    """What deleting ``user`` would touch — shown before the admin confirms."""
    count, total = (
        await db.execute(
            select(func.count(UserFile.id), func.coalesce(func.sum(UserFile.size_bytes), 0)).where(
                UserFile.user_id == user.id
            )
        )
    ).one()
    convs = (
        await db.execute(select(func.count(Conversation.id)).where(Conversation.user_id == user.id))
    ).scalar_one()
    out = DeletionPreview(file_count=int(count), file_bytes=int(total), conversation_count=int(convs))
    for ws in (
        await db.execute(select(Workspace).where(Workspace.user_id == user.id).order_by(Workspace.title))
    ).scalars():
        out.workspaces.append(
            OwnedWorkspace(id=ws.id, title=ws.title, member_ids=await member_ids(db, ws.id))
        )
    return out


async def purge_user(
    db: AsyncSession,
    user: User,
    *,
    transfers: dict[uuid.UUID, uuid.UUID] | None = None,
    actor: User | None = None,
    request: Request | None = None,
) -> bool:
    """Hard-delete ``user`` after handing shared work to its new owners.

    ``transfers`` maps each owned workspace to keep onto its new owner (a
    member of that workspace, or an admin). A workspace with other members
    that isn't in ``transfers`` refuses the whole deletion — losing a team's
    work must never be the default. Workspaces nobody else uses go with the
    user unless transferred.

    Returns ``False`` for a protected (admin) account; raises
    :class:`DeletionRefused` for a bad request. Commits.
    """
    if _protected(user):
        logger.warning("refusing to purge admin account %s (%s)", user.id, user.email)
        return False
    transfers = dict(transfers or {})
    uid = user.id

    preview = await deletion_preview(db, user)
    owned = {w.id: w for w in preview.workspaces}
    unknown = set(transfers) - set(owned)
    if unknown:
        raise DeletionRefused("A workspace to transfer isn't owned by this user.")
    stranded = [w.title for w in preview.workspaces if w.member_ids and w.id not in transfers]
    if stranded:
        raise DeletionRefused(
            "Choose a new owner for these shared workspaces first: " + ", ".join(stranded)
        )

    transferred: list[str] = []
    for ws_id, new_owner_id in transfers.items():
        new_owner = await db.get(User, new_owner_id)
        w = owned[ws_id]
        if new_owner is None or new_owner.id == uid or new_owner.disabled:
            raise DeletionRefused(f"Pick an active user to own “{w.title}”.")
        if new_owner.role != "admin" and new_owner.id not in w.member_ids:
            raise DeletionRefused(
                f"The new owner of “{w.title}” must be one of its members or an admin."
            )
        ws = await db.get(Workspace, ws_id)
        await transfer_workspace(db, ws, new_owner)
        transferred.append(w.title)

    # Invitations they sent to workspaces that survive: hand to the owner,
    # or every member they invited would lose access (inviter FK cascades).
    for share in (
        await db.execute(
            select(WorkspaceShare, Workspace.user_id)
            .join(Workspace, Workspace.id == WorkspaceShare.workspace_id)
            .where(WorkspaceShare.inviter_user_id == uid, Workspace.user_id != uid)
        )
    ).all():
        share[0].inviter_user_id = share[1]

    # Workspace chats they started where the team can see them: keep them
    # with the workspace's owner. Private chats leave with the user.
    handed_chats = 0
    for conv, owner_id in (
        await db.execute(
            select(Conversation, Workspace.user_id)
            .join(Workspace, Workspace.id == Conversation.workspace_id)
            .where(
                Conversation.user_id == uid,
                Conversation.visibility == "workspace",
                Workspace.user_id != uid,
            )
        )
    ).all():
        conv.user_id = owner_id
        handed_chats += 1

    await db.flush()
    remaining_files, remaining_bytes = (
        await db.execute(
            select(func.count(UserFile.id), func.coalesce(func.sum(UserFile.size_bytes), 0)).where(
                UserFile.user_id == uid
            )
        )
    ).one()
    # The whole bucket goes on a 14-day timer; the sweep spares any file a
    # row still points at (everything that was just transferred).
    tombstone(
        db,
        f"u_{uid}",
        reason="user_deleted",
        size_bytes=int(remaining_bytes),
        user_id=uid,
        is_dir=True,
    )

    from app.auth.audit import record_event

    deleted_ws = [w.title for w in preview.workspaces if w.id not in transfers]
    detail = (
        f"{user.username} <{user.email}> deleted"
        + (f" by {actor.username}" if actor else "")
        + f"; files={int(remaining_files)}"
        + f"; transferred={len(transferred)}; deleted_workspaces={len(deleted_ws)}"
        + f"; chats_handed_over={handed_chats}"
    )
    await record_event(
        db,
        event_type=EVENT_USER_DELETED,
        request=request,
        user_id=actor.id if actor else None,
        identifier=user.email,
        detail=detail[:512],
    )
    # Workspaces still owned here (the solo ones) cascade with the user.
    await db.delete(user)
    await db.commit()
    logger.info("purged user %s: %s", uid, detail)
    return True


__all__ = ["DeletionRefused", "deletion_preview", "purge_user"]

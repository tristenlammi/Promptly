"""Delete a user without taking other people's work with them (R-004).

DB-level ``ON DELETE CASCADE`` removes everything a user owns. That used to
include every workspace they owned — and with it notes, boards and files
their collaborators wrote, which are stored under the owner's account — plus
the shares they'd sent (so members of *other* workspaces lost access) and
the workspace chats they'd started. All of it went with no record.

Now deletion is an offboarding step:

* a workspace that other people work in goes to one of them
  (:func:`app.workspaces.ownership.transfer_workspace`): the longest-standing
  member who can edit it (workspace admins before editors), or another such
  member the admin picks. With nobody who can edit it, it's deleted;
* a private workspace (nobody else in it) always goes with the account. The
  server admin can never take it over, or take over a shared one they
  weren't in (admin privacy audit L2); someone who wants to keep their own
  work exports it first (Export my library);
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
    # Members who can edit it (workspace admins, then editors; each the
    # longest-standing first; active accounts before disabled ones). The
    # first one takes it over unless the admin picks another.
    heir_ids: list[uuid.UUID] = field(default_factory=list)

    @property
    def shared(self) -> bool:
        return bool(self.member_ids)


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
            OwnedWorkspace(
                id=ws.id,
                title=ws.title,
                member_ids=await member_ids(db, ws.id),
                heir_ids=await _heirs(db, ws.id),
            )
        )
    return out


async def _heirs(db: AsyncSession, workspace_id: uuid.UUID) -> list[uuid.UUID]:
    """Accepted members who can edit ``workspace_id``, best heir first."""
    rows = await db.execute(
        select(WorkspaceShare.invitee_user_id)
        .join(User, User.id == WorkspaceShare.invitee_user_id)
        .where(
            WorkspaceShare.workspace_id == workspace_id,
            WorkspaceShare.status == "accepted",
            WorkspaceShare.role.in_(("admin", "editor")),
        )
        .order_by(
            User.disabled.asc(),
            (WorkspaceShare.role != "admin").asc(),
            func.coalesce(WorkspaceShare.accepted_at, WorkspaceShare.created_at).asc(),
            WorkspaceShare.created_at.asc(),
        )
    )
    return [r for (r,) in rows]


async def purge_user(
    db: AsyncSession,
    user: User,
    *,
    transfers: dict[uuid.UUID, uuid.UUID] | None = None,
    actor: User | None = None,
    request: Request | None = None,
) -> bool:
    """Hard-delete ``user`` after handing shared work to its new owners.

    Every workspace other people work in goes to one of its members who can
    edit it: the first of :attr:`OwnedWorkspace.heir_ids`, unless
    ``transfers`` (workspace id -> member id) picks another of them. One
    with no such member is deleted. Private workspaces always go with the
    account; ``transfers`` can't name one, and can't name anyone outside the
    workspace, the server admin included.

    Returns ``False`` for a protected (admin) account; raises
    :class:`DeletionRefused` for a bad request. Commits.
    """
    if _protected(user):
        logger.warning("refusing to purge admin account %s", user.id)
        return False
    transfers = dict(transfers or {})
    uid = user.id

    preview = await deletion_preview(db, user)
    owned = {w.id: w for w in preview.workspaces}
    for ws_id, new_owner_id in transfers.items():
        w = owned.get(ws_id)
        if w is None or not w.shared:
            raise DeletionRefused(
                "Only a workspace this user shares with others can be handed over."
            )
        if new_owner_id not in w.heir_ids:
            raise DeletionRefused(
                "A shared workspace can only go to one of its members who can edit it."
            )

    transferred = 0
    for w in preview.workspaces:
        if not w.shared:
            continue
        new_owner_id = transfers.get(w.id) or (w.heir_ids[0] if w.heir_ids else None)
        if new_owner_id is None:
            continue  # nobody left who can edit it: it goes with the account
        new_owner = await db.get(User, new_owner_id)
        if new_owner is None or new_owner.id == uid:
            continue
        ws = await db.get(Workspace, w.id)
        await transfer_workspace(db, ws, new_owner)
        transfers[w.id] = new_owner.id
        transferred += 1

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

    deleted_ws = sum(1 for w in preview.workspaces if w.id not in transfers)
    detail = (
        f"{user.username} <{user.email}> deleted"
        + (f" by {actor.username}" if actor else "")
        + f"; files={int(remaining_files)}"
        + f"; transferred={transferred}; deleted_workspaces={deleted_ws}"
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
    # Forms: a form row never cascades from its shell, so their forms (and
    # the answers) go first, or the files' cascade would be refused.
    from sqlalchemy import text as _text

    await db.execute(
        _text("DELETE FROM forms WHERE file_id IN (SELECT id FROM files WHERE user_id = :u)"), {"u": uid}
    )
    # Workspaces still owned here (private ones, and shared ones nobody else
    # can edit) cascade with the user.
    await db.delete(user)
    await db.commit()
    logger.info("purged user %s: transferred=%d deleted_workspaces=%d", uid, transferred, deleted_ws)
    return True


__all__ = ["DeletionRefused", "deletion_preview", "purge_user"]
